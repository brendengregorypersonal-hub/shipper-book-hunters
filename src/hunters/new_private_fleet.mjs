// New Private Fleet: companies that registered their own trucks with the DOT in the last 180 days and have 3 or more power units.
// A new registration is a company that has just started moving its own freight. Every run reads the whole 180-day window
// (a few thousand companies), so a company's details stay fresh while it is in the window.
import { compact, fetchPage, ownFleetSignal, today, toPoolRow } from "../lib/fmcsa.mjs";

const WINDOW_DAYS = 180;
const MIN_POWER_UNITS = 3;
const PAGE = 5000;

export async function run({ fetchJson, db, cap, log, seen, now = new Date() }) {
  const since = compact(new Date(now.getTime() - WINDOW_DAYS * 86400000));
  const observedAt = today();
  let after = 0;
  let taken = 0;
  while (taken < cap) {
    const limit = Math.min(PAGE, cap - taken);
    const page = await fetchPage(fetchJson, {
      where: `classdef='PRIVATE PROPERTY' AND status_code='A' AND add_date>='${since}' AND power_units::number>=${MIN_POWER_UNITS} AND dot_number>${after}`,
      limit,
    });
    seen(page.length);
    const rows = page.map(toPoolRow).filter(Boolean);
    await db.upsertPool(rows);
    await db.insertSignals(rows.map((r) => ownFleetSignal(r, { hunter: "new_private_fleet", observedAt, newlyRegistered: true })));
    taken += page.length;
    if (page.length > 0) after = Number(page[page.length - 1].dot_number);
    log(`new_private_fleet: ${taken} so far (registered since ${since})`);
    if (page.length < limit) break;
  }
  return { cursor: { last_window_start: since } };
}
