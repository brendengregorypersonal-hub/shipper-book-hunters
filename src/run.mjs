// Runs one hunter (or every hunter that is due) and records how it went.
//
//   node src/run.mjs --hunter private_fleet --trigger cron
//   node src/run.mjs --hunter due --trigger schedule        (the backup schedule: only hunters that are due)
//
// A hunter is a file in src/hunters/ that exports `run(ctx)`. It collects public data and saves it to the shared pool.
// It never scores, matches or decides anything about a company: that happens in the private Shipper Book app.
import { fetchJson } from "./lib/limiter.mjs";
import { clean } from "./lib/normalize.mjs";
import * as database from "./lib/db.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

export async function runHunter({ pool, hunter, trigger, runUrl = null, load = (name) => import(`./hunters/${name}.mjs`), log = console.log }) {
  if (!/^[a-z_]{3,40}$/.test(hunter)) throw new Error(`"${hunter}" isn't a hunter name.`);
  const state = await database.getState(pool, hunter);
  if (!state) throw new Error(`There is no hunter called "${hunter}".`);
  if (!state.enabled && trigger !== "manual") {
    log(`${hunter}: switched off, skipping.`);
    return { skipped: true };
  }
  const runId = await database.startRun(pool, { hunter, trigger, runUrl, attempt: state.consecutive_failures + 1 });
  try {
    let mod;
    try {
      mod = await load(hunter);
    } catch (e) {
      throw new Error(`The ${hunter} hunter isn't built yet (${e.code ?? e.message}).`);
    }
    const counts = { seen: 0, upserted: 0, signals: 0 };
    const result = await mod.run({
      fetchJson,
      cap: state.nightly_cap,
      cursor: state.cursor ?? {},
      log,
      db: {
        upsertPool: async (rows) => {
          const r = await database.upsertPool(pool, rows);
          counts.upserted += r.inserted + r.updated;
          return r;
        },
        insertSignals: async (rows) => {
          const n = await database.insertSignals(pool, rows);
          counts.signals += n;
          return n;
        },
      },
      seen: (n) => { counts.seen += n; },
    });
    await database.finishRun(pool, runId, hunter, { ok: true, ...counts, cursor: result?.cursor ?? null });
    log(`${hunter}: done. Saw ${counts.seen}, saved ${counts.upserted} companies and ${counts.signals} new signals.`);
    return { ok: true, ...counts };
  } catch (e) {
    await database.finishRun(pool, runId, hunter, { ok: false, error: clean(e.message) ?? "unknown error" });
    log(`${hunter}: FAILED. ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function main() {
  const hunter = arg("hunter", "due");
  const trigger = arg("trigger", "manual");
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
  const pool = database.connect();
  let failed = false;
  try {
    const names = hunter === "due" ? await database.dueHunters(pool) : [hunter];
    if (names.length === 0) console.log("No hunter is due.");
    for (const name of names) {
      const r = await runHunter({ pool, hunter: name, trigger, runUrl });
      if (r.ok === false) failed = true;
    }
  } finally {
    await pool.end();
  }
  if (failed) process.exitCode = 1; // shows the run as failed on GitHub; the watchdog in the database starts it again
}

if (process.argv[1]?.split("\\").join("/").endsWith("/src/run.mjs")) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
