// The hunters' only door to the database. They log in as "radar_hunter", which can add to and update the shared pool and the
// run log and can't read or change anything that belongs to a company. The password lives only in the HUNTER_DATABASE_URL secret.
import pg from "pg";

export function connect(url = process.env.HUNTER_DATABASE_URL) {
  if (!url) throw new Error("HUNTER_DATABASE_URL is not set.");
  const local = /@(localhost|127\.0\.0\.1)/.test(url);
  return new pg.Pool({ connectionString: url, max: 2, ssl: local ? false : { rejectUnauthorized: false } });
}

export async function startRun(pool, { hunter, trigger, attempt = 1, runUrl = null }) {
  const { rows } = await pool.query(
    "insert into public.radar_hunter_runs (hunter, trigger, attempt, run_url) values ($1, $2, $3, $4) returning id",
    [hunter, trigger, attempt, runUrl],
  );
  await pool.query("update public.radar_hunter_state set last_run_at = now() where hunter = $1", [hunter]);
  return rows[0].id;
}

export async function finishRun(pool, id, hunter, { ok, seen = 0, upserted = 0, signals = 0, error = null, cursor = null }) {
  await pool.query(
    "update public.radar_hunter_runs set status = $2, finished_at = now(), rows_seen = $3, rows_upserted = $4, signals_added = $5, error = $6 where id = $1",
    [id, ok ? "ok" : "failed", seen, upserted, signals, error ? String(error).slice(0, 2000) : null],
  );
  await pool.query(
    `update public.radar_hunter_state set last_status = $2,
            last_success_at = case when $3 then now() else last_success_at end,
            consecutive_failures = case when $3 then 0 else consecutive_failures + 1 end,
            cursor = coalesce($4::jsonb, cursor), updated_at = now()
      where hunter = $1`,
    [hunter, ok ? "ok" : "failed", ok, cursor ? JSON.stringify(cursor) : null],
  );
}

export async function getState(pool, hunter) {
  const { rows } = await pool.query("select hunter, enabled, nightly_cap, cursor, consecutive_failures from public.radar_hunter_state where hunter = $1", [hunter]);
  return rows[0] ?? null;
}

export async function dueHunters(pool, hours = 20) {
  const { rows } = await pool.query(
    `select hunter from public.radar_hunter_state
      where enabled and consecutive_failures < 3 and (last_success_at is null or last_success_at < now() - ($1 || ' hours')::interval)
      order by hunter`,
    [String(hours)],
  );
  return rows.map((r) => r.hunter);
}

const POOL_FIELDS = "source text, source_key text, name text, dba text, street text, city text, state text, zip text, lat float8, lng float8, phone text, email text, website text, domain text, contacts jsonb, attrs jsonb";

/**
 * Adds or refreshes public company rows (up to a few hundred at a time). A row that already exists is refreshed and noted as
 * changed only when something it says actually changed. Returns how many were new.
 */
export async function upsertPool(pool, rows) {
  if (rows.length === 0) return { inserted: 0, updated: 0 };
  // one row per registration in a batch (the database refuses to change the same row twice in one go): the last one wins
  rows = [...new Map(rows.map((r) => [`${r.source}|${r.source_key}`, r])).values()];
  const payload = rows.map((r) => ({
    source: r.source, source_key: String(r.source_key), name: r.name, dba: r.dba ?? null, street: r.street ?? null, city: r.city ?? null,
    state: r.state ?? null, zip: r.zip ?? null, lat: r.lat ?? null, lng: r.lng ?? null, phone: r.phone ?? null, email: r.email ?? null,
    website: r.website ?? null, domain: r.domain ?? null, contacts: r.contacts ?? [], attrs: r.attrs ?? {},
  }));
  const { rows: out } = await pool.query(
    `insert into public.radar_pool_companies as p (source, source_key, name, dba, street, city, state, zip, lat, lng, phone, email, website, domain, contacts, attrs)
     select source, source_key, name, dba, street, city, state, zip, lat, lng, phone, email, website, domain, coalesce(contacts, '[]'::jsonb), coalesce(attrs, '{}'::jsonb)
       from jsonb_to_recordset($1::jsonb) as x(${POOL_FIELDS})
     on conflict (source, source_key) do update set
       name = excluded.name, dba = excluded.dba, street = excluded.street, city = excluded.city, state = excluded.state, zip = excluded.zip,
       lat = coalesce(excluded.lat, p.lat), lng = coalesce(excluded.lng, p.lng), phone = excluded.phone, email = excluded.email,
       website = excluded.website, domain = excluded.domain, contacts = excluded.contacts, attrs = excluded.attrs,
       active = true, last_seen_at = now(),
       last_changed_at = case when (p.name, p.dba, p.street, p.city, p.state, p.zip, p.phone, p.email, p.website, p.contacts, p.attrs)
                                 is distinct from (excluded.name, excluded.dba, excluded.street, excluded.city, excluded.state, excluded.zip, excluded.phone, excluded.email, excluded.website, excluded.contacts, excluded.attrs)
                              then now() else p.last_changed_at end
     returning (xmax = 0) as inserted`,
    [JSON.stringify(payload)],
  );
  const inserted = out.filter((r) => r.inserted).length;
  return { inserted, updated: out.length - inserted };
}

/** Adds signals about pool companies (named by source and source_key). A signal already saved is left alone. Returns how many were new. */
export async function insertSignals(pool, rows) {
  if (rows.length === 0) return 0;
  const payload = rows.map((r) => ({
    source: r.source, source_key: String(r.source_key), hunter: r.hunter, signal_type: r.signal_type, dedupe_key: r.dedupe_key ?? "",
    observed_at: r.observed_at, title: r.title, source_url: r.source_url ?? null, detail: r.detail ?? {},
  }));
  const res = await pool.query(
    `insert into public.radar_pool_signals (pool_id, hunter, signal_type, dedupe_key, observed_at, title, source_url, detail)
     select p.id, x.hunter, x.signal_type, x.dedupe_key, x.observed_at, x.title, x.source_url, coalesce(x.detail, '{}'::jsonb)
       from jsonb_to_recordset($1::jsonb) as x(source text, source_key text, hunter text, signal_type text, dedupe_key text, observed_at date, title text, source_url text, detail jsonb)
       join public.radar_pool_companies p on p.source = x.source and p.source_key = x.source_key
     on conflict do nothing`,
    [JSON.stringify(payload)],
  );
  return res.rowCount ?? 0;
}
