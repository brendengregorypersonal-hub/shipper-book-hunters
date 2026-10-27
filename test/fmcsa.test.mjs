import { test } from "node:test";
import assert from "node:assert/strict";
import { ownFleetSignal, toPoolRow } from "../src/lib/fmcsa.mjs";
import { run as privateFleet } from "../src/hunters/private_fleet.mjs";
import { run as newPrivateFleet } from "../src/hunters/new_private_fleet.mjs";

// a real registration (October 2026), trimmed
const AARONS = {
  dot_number: "363", legal_name: "AARON'S LLC", power_units: "1754", total_drivers: "2704", carrier_operation: "A", mcs150_mileage: "24217213",
  crgo_genfreight: "X", crgo_cargoothr: "X", crgo_cargoothr_desc: "OFFICE FURNITURE", crgo_household: "X", phone: "6784023132",
  email_address: "Erica.Forte@aarons.com", company_officer_1: "STEVE OLSEN", phy_street: "400 GALLERIA PKWY SE", phy_city: "ATLANTA", phy_state: "GA", phy_zip: "30339", add_date: "19740601", mcs150_date: "20260809",
};

test("a census record becomes a pool row with its source and the facts the registration gives", () => {
  const r = toPoolRow(AARONS);
  assert.equal(r.source, "fmcsa");
  assert.equal(r.source_key, "363");
  assert.equal(r.name, "Aaron's LLC");
  assert.equal(r.city, "Atlanta");
  assert.equal(r.state, "GA");
  assert.equal(r.phone, "(678) 402-3132");
  assert.equal(r.email, "erica.forte@aarons.com");
  assert.equal(r.domain, "aarons.com");
  assert.deepEqual(r.contacts, [{ name: "Steve Olsen", role: "Company officer", source: "fmcsa_registration" }]);
  assert.equal(r.attrs.power_units, 1754);
  assert.equal(r.attrs.drivers, 2704);
  assert.deepEqual(r.attrs.cargo, ["genfreight", "household", "cargoothr"]);
  assert.equal(r.attrs.cargo_other, "OFFICE FURNITURE");
  assert.equal(r.attrs.registered, "1974-06-01");
  assert.match(r.attrs.source_url, /safer\.fmcsa\.dot\.gov.*363/);
});

test("a record with no name or number is skipped; a free mail address gives no company domain", () => {
  assert.equal(toPoolRow({ dot_number: "5" }), null);
  assert.equal(toPoolRow({ legal_name: "X" }), null);
  assert.equal(toPoolRow({ dot_number: "7", legal_name: "SMALL CO", email_address: "owner@gmail.com" }).domain, null);
});

test("the signals say what happened, with a date and a source", () => {
  const row = toPoolRow(AARONS);
  const own = ownFleetSignal(row, { hunter: "private_fleet", observedAt: "2026-10-27" });
  assert.equal(own.signal_type, "runs_own_fleet");
  assert.equal(own.observed_at, "2026-10-27");
  assert.match(own.title, /1754 power units/);
  const fresh = ownFleetSignal(toPoolRow({ ...AARONS, add_date: "20261020", power_units: "4" }), { hunter: "new_private_fleet", observedAt: "2026-10-27", newlyRegistered: true });
  assert.equal(fresh.signal_type, "newly_registered_fleet");
  assert.equal(fresh.observed_at, "2026-10-20");
  assert.match(fresh.title, /on 2026-10-20 \(4 power units\)/);
});

const harness = (pages) => {
  const asked = [];
  const saved = { rows: [], signals: [] };
  return {
    asked, saved,
    fetchJson: async (url) => { asked.push(decodeURIComponent(url.split("+").join(" "))); return pages.shift() ?? []; },
    db: { upsertPool: async (rows) => { saved.rows.push(...rows); return {}; }, insertSignals: async (rows) => { saved.signals.push(...rows); return rows.length; } },
    seen: () => {},
    log: () => {},
  };
};
const rec = (dot, units = "12") => ({ ...AARONS, dot_number: String(dot), power_units: units });

test("Private Fleet takes the next slice after its place, stops at the cap and remembers where it got to", async () => {
  const h = harness([[rec(10), rec(20)]]);
  const out = await privateFleet({ ...h, cap: 2, cursor: { after_dot: 5 } });
  assert.match(h.asked[0], /dot_number>5/);
  assert.match(h.asked[0], /classdef='PRIVATE PROPERTY' AND status_code='A' AND power_units::number>=10/);
  assert.equal(h.saved.rows.length, 2);
  assert.equal(h.saved.signals.length, 2);
  assert.deepEqual(out.cursor.after_dot, 20);
});

test("Private Fleet starts over from the top when it reaches the end of the list", async () => {
  const h = harness([[rec(10)]]);
  const out = await privateFleet({ ...h, cap: 5000, cursor: { after_dot: 9 } });
  assert.equal(out.cursor.after_dot, 0);
  assert.ok(out.cursor.finished_pass_at);
});

test("New Private Fleet asks for the last 180 days and 3 or more trucks, and marks the signal as a new registration", async () => {
  const h = harness([[rec(30, "4")]]);
  const out = await newPrivateFleet({ ...h, cap: 5000, now: new Date("2026-10-27T12:00:00Z") });
  assert.match(h.asked[0], /add_date>='20260430'/);
  assert.match(h.asked[0], /power_units::number>=3/);
  assert.equal(h.saved.signals[0].signal_type, "newly_registered_fleet");
  assert.equal(out.cursor.last_window_start, "20260430");
});
