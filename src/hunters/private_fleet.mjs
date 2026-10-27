// Private Fleet: companies that run their own trucks (FMCSA "private property" carriers, not for hire) with 10 or more power units.
// The whole list is too big for one night, so each run takes the next slice (up to the nightly cap), in registration-number order,
// and remembers where it got to. When it reaches the end it starts again from the top, which refreshes every company in turn.
import { fetchPage, ownFleetSignal, today, toPoolRow } from "../lib/fmcsa.mjs";

const MIN_POWER_UNITS = 10;
const PAGE = 5000;

export async function run({ fetchJson, db, cap, cursor, log, seen }) {
  let after = Number(cursor?.after_dot) || 0;
  let taken = 0;
  let last = after;
  let reachedEnd = false;
  const observedAt = today();
  while (taken < cap) {
    const limit = Math.min(PAGE, cap - taken);
    const page = await fetchPage(fetchJson, {
      where: `classdef='PRIVATE PROPERTY' AND status_code='A' AND power_units::number>=${MIN_POWER_UNITS} AND dot_number>${last}`,
      limit,
    });
    seen(page.length);
    const rows = page.map(toPoolRow).filter(Boolean);
    await db.upsertPool(rows);
    await db.insertSignals(rows.map((r) => ownFleetSignal(r, { hunter: "private_fleet", observedAt })));
    taken += page.length;
    if (page.length > 0) last = Number(page[page.length - 1].dot_number);
    log(`private_fleet: ${taken} so far, up to registration number ${last}`);
    if (page.length < limit) { reachedEnd = true; break; }
  }
  return { cursor: { after_dot: reachedEnd ? 0 : last, finished_pass_at: reachedEnd ? observedAt : (cursor?.finished_pass_at ?? null) } };
}
