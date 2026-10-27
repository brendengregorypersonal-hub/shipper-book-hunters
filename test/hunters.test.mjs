import { test } from "node:test";
import assert from "node:assert/strict";
import { createLimiter, fetchJson } from "../src/lib/limiter.mjs";
import { clean, cleanEmail, cleanPhone, domainOf, tidyName, toDate, toInt } from "../src/lib/normalize.mjs";
import { upsertPool, insertSignals } from "../src/lib/db.mjs";
import { runHunter } from "../src/run.mjs";

test("the limiter keeps at least the minimum gap between jobs, in order", async () => {
  let clock = 0;
  const waits = [];
  const schedule = createLimiter({ minGapMs: 1000, now: () => clock, wait: async (ms) => { waits.push(ms); clock += ms; } });
  const order = [];
  await Promise.all([1, 2, 3].map((n) => schedule(async () => { order.push(n); })));
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(waits, [1000, 1000]); // the first goes at once, the next two each wait a second
});

test("one failed job doesn't stop the line", async () => {
  const schedule = createLimiter({ minGapMs: 0 });
  await assert.rejects(schedule(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await schedule(async () => "next"), "next");
});

const answer = (status, body = {}, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] }, json: async () => body });

test("fetchJson retries busy answers with growing waits and then succeeds", async () => {
  const seen = [];
  const waits = [];
  const replies = [answer(429), answer(503), answer(200, { ok: 1 })];
  const out = await fetchJson("https://example.org/a", { schedule: (j) => j(), fetchImpl: async () => replies.shift(), wait: async (ms) => waits.push(ms), baseDelayMs: 100 });
  assert.deepEqual(out, { ok: 1 });
  assert.deepEqual(waits, [100, 200]);
  assert.equal(seen.length, 0);
});

test("fetchJson honours Retry-After, and doesn't retry a plain refusal", async () => {
  const waits = [];
  const replies = [answer(429, {}, { "retry-after": "7" }), answer(200, { a: 1 })];
  await fetchJson("https://example.org/a", { schedule: (j) => j(), fetchImpl: async () => replies.shift(), wait: async (ms) => waits.push(ms) });
  assert.deepEqual(waits, [7000]);
  let calls = 0;
  await assert.rejects(fetchJson("https://example.org/b", { schedule: (j) => j(), fetchImpl: async () => { calls++; return answer(404); }, wait: async () => {} }), /404/);
  assert.equal(calls, 1);
});

test("fetchJson gives up after the retries with a clear error", async () => {
  let calls = 0;
  await assert.rejects(fetchJson("https://example.org/c", { retries: 2, schedule: (j) => j(), fetchImpl: async () => { calls++; return answer(500); }, wait: async () => {} }), /500 from example.org/);
  assert.equal(calls, 3);
});

test("tidy-ups: names, phones, emails, domains, dates, numbers", () => {
  assert.equal(clean("  a   b "), "a b");
  assert.equal(clean("   "), null);
  assert.equal(cleanEmail(" Ops@Example.COM "), "ops@example.com");
  assert.equal(cleanEmail("not an email"), null);
  assert.equal(cleanPhone("6025550100"), "(602) 555-0100");
  assert.equal(cleanPhone("1-602-555-0100"), "(602) 555-0100");
  assert.equal(cleanPhone("555"), "555");
  assert.equal(cleanPhone(""), null);
  assert.equal(tidyName("ACME FOODS LLC"), "Acme Foods LLC");
  assert.equal(tidyName("Already Mixed Case"), "Already Mixed Case");
  assert.equal(domainOf("ops@goevolvesolar.com"), "goevolvesolar.com");
  assert.equal(domainOf("https://www.example.org/about?x=1"), "example.org");
  assert.equal(domainOf("someone@gmail.com"), null); // a free mail address says nothing about the company
  assert.equal(toDate("20261026"), "2026-10-26");
  assert.equal(toDate("2026-10-26T00:00:00.000"), "2026-10-26");
  assert.equal(toDate("20261340"), null);
  assert.equal(toInt("1,250"), 1250);
  assert.equal(toInt(""), null);
});

const fakePool = (rowsFor = () => []) => {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: rowsFor(sql, params), rowCount: 1 }; } };
};

test("saving companies: one row per registration in a batch, counts new and refreshed", async () => {
  const pool = fakePool(() => [{ inserted: true }, { inserted: false }]);
  const r = await upsertPool(pool, [
    { source: "fmcsa", source_key: "1", name: "A" }, { source: "fmcsa", source_key: "1", name: "A again" }, { source: "fmcsa", source_key: "2", name: "B" },
  ]);
  assert.deepEqual(r, { inserted: 1, updated: 1 });
  const sent = JSON.parse(pool.calls[0].params[0]);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].name, "A again"); // the last one wins
  assert.match(pool.calls[0].sql, /on conflict \(source, source_key\)/);
  assert.deepEqual(await upsertPool(fakePool(), []), { inserted: 0, updated: 0 });
});

test("saving signals goes by source and key, and leaves existing ones alone", async () => {
  const pool = fakePool();
  assert.equal(await insertSignals(pool, [{ source: "fmcsa", source_key: "9", hunter: "private_fleet", signal_type: "registered", observed_at: "2026-10-01", title: "t" }]), 1);
  assert.match(pool.calls[0].sql, /on conflict do nothing/);
  assert.equal(JSON.parse(pool.calls[0].params[0])[0].dedupe_key, "");
});

const runPool = (state) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/from public.radar_hunter_state where hunter/.test(sql)) return { rows: state ? [state] : [] };
      if (/insert into public.radar_hunter_runs/.test(sql)) return { rows: [{ id: "run-1" }] };
      return { rows: [], rowCount: 0 };
    },
  };
};
const quiet = () => {};

test("a run is recorded as ok with its counts, and the hunter's place is kept", async () => {
  const pool = runPool({ hunter: "private_fleet", enabled: true, nightly_cap: 100, cursor: {}, consecutive_failures: 0 });
  const r = await runHunter({ pool, hunter: "private_fleet", trigger: "cron", log: quiet, load: async () => ({ run: async (ctx) => { ctx.seen(5); await ctx.db.upsertPool([]); return { cursor: { page: 2 } }; } }) });
  assert.equal(r.ok, true);
  const done = pool.calls.find((c) => /set status = \$2, finished_at/.test(c.sql));
  assert.equal(done.params[1], "ok");
  assert.equal(done.params[2], 5);
  const state = pool.calls.find((c) => /update public.radar_hunter_state set last_status/.test(c.sql));
  assert.equal(state.params[3], JSON.stringify({ page: 2 }));
});

test("a failing hunter is recorded as failed (so the watchdog can start it again) and the error is kept", async () => {
  const pool = runPool({ hunter: "private_fleet", enabled: true, nightly_cap: 100, cursor: {}, consecutive_failures: 1 });
  const r = await runHunter({ pool, hunter: "private_fleet", trigger: "watchdog", log: quiet, load: async () => ({ run: async () => { throw new Error("the source was down"); } }) });
  assert.equal(r.ok, false);
  const done = pool.calls.find((c) => /set status = \$2, finished_at/.test(c.sql));
  assert.equal(done.params[1], "failed");
  assert.match(done.params[5], /the source was down/);
  const started = pool.calls.find((c) => /insert into public.radar_hunter_runs/.test(c.sql));
  assert.equal(started.params[2], 2); // second attempt
});

test("a switched-off hunter is skipped unless started by hand; a hunter that isn't built yet fails clearly", async () => {
  const off = runPool({ hunter: "gov_bids", enabled: false, nightly_cap: 1, cursor: {}, consecutive_failures: 0 });
  assert.equal((await runHunter({ pool: off, hunter: "gov_bids", trigger: "cron", log: quiet })).skipped, true);
  assert.equal(off.calls.some((c) => /insert into public.radar_hunter_runs/.test(c.sql)), false);
  const unbuilt = runPool({ hunter: "gov_bids", enabled: true, nightly_cap: 1, cursor: {}, consecutive_failures: 0 });
  const r = await runHunter({ pool: unbuilt, hunter: "gov_bids", trigger: "cron", log: quiet, load: async () => { throw Object.assign(new Error("x"), { code: "ERR_MODULE_NOT_FOUND" }); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /isn't built yet/);
});

test("odd hunter names are refused before anything runs", async () => {
  await assert.rejects(runHunter({ pool: runPool(null), hunter: "../etc/passwd", trigger: "manual", log: quiet }), /isn't a hunter name/);
  await assert.rejects(runHunter({ pool: runPool(null), hunter: "nothing_here", trigger: "manual", log: quiet }), /no hunter called/);
});
