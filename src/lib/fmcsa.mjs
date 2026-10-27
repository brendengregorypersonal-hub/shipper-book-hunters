// The FMCSA Company Census File (data.transportation.gov, dataset az4n-8mr2): every carrier registered with the Department of
// Transportation. "Private property" carriers are companies hauling their OWN freight (not for hire): shippers running their own trucks.
// Collection only: this saves what the registration says. Whether a company is a good lead is decided in the private Shipper Book app.
import { clean, cleanEmail, cleanPhone, domainOf, tidyName, toDate, toInt } from "./normalize.mjs";

export const CENSUS_URL = "https://data.transportation.gov/resource/az4n-8mr2.json";

// What the registration says a company hauls (each flag is "X" when ticked)
const CARGO_FLAGS = [
  "genfreight", "household", "metalsheet", "motoveh", "drivetow", "logpole", "bldgmat", "mobilehome", "machlrg", "produce", "liqgas",
  "intermodal", "passengers", "oilfield", "livestock", "grainfeed", "coalcoke", "meat", "garbage", "usmail", "chem", "drybulk", "coldfood",
  "beverages", "paperprod", "utility", "farmsupp", "construct", "waterwell", "cargoothr",
];

export const FIELDS = [
  "dot_number", "legal_name", "dba_name", "status_code", "classdef", "carrier_operation", "power_units", "total_drivers", "mcs150_mileage",
  "mcs150_date", "add_date", "phone", "cell_phone", "email_address", "company_officer_1", "company_officer_2",
  "phy_street", "phy_city", "phy_state", "phy_zip", "phy_country", "crgo_cargoothr_desc",
  ...CARGO_FLAGS.map((c) => `crgo_${c}`),
].join(",");

export const safer = (dot) => `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${encodeURIComponent(dot)}`;

/** One census record -> one row of the shared pool (or null if it has no usable name or number) */
export function toPoolRow(r) {
  const dot = clean(r.dot_number);
  const name = tidyName(r.legal_name);
  if (!dot || !name) return null;
  const officers = [r.company_officer_1, r.company_officer_2].map(tidyName).filter(Boolean);
  const email = cleanEmail(r.email_address);
  return {
    source: "fmcsa",
    source_key: dot,
    name,
    dba: tidyName(r.dba_name),
    street: clean(r.phy_street),
    city: tidyName(r.phy_city),
    state: clean(r.phy_state)?.toUpperCase().slice(0, 2) ?? null,
    zip: clean(r.phy_zip),
    phone: cleanPhone(r.phone) ?? cleanPhone(r.cell_phone),
    email,
    domain: domainOf(email),
    contacts: [...new Set(officers)].map((n) => ({ name: n, role: "Company officer", source: "fmcsa_registration" })),
    attrs: {
      dot_number: dot,
      power_units: toInt(r.power_units),
      drivers: toInt(r.total_drivers),
      annual_miles: toInt(r.mcs150_mileage),
      operation: clean(r.carrier_operation), // A interstate, B interstate with hazardous materials, C intrastate
      cargo: CARGO_FLAGS.filter((c) => clean(r[`crgo_${c}`])),
      cargo_other: clean(r.crgo_cargoothr_desc)?.slice(0, 200) ?? null,
      registered: toDate(r.add_date),
      registration_updated: toDate(r.mcs150_date),
      source_url: safer(dot),
    },
  };
}

/** The "own fleet" signal: a company that registered its own trucks with the Department of Transportation */
export function ownFleetSignal(row, { hunter, observedAt, newlyRegistered = false }) {
  const units = row.attrs.power_units;
  return {
    source: row.source,
    source_key: row.source_key,
    hunter,
    signal_type: newlyRegistered ? "newly_registered_fleet" : "runs_own_fleet",
    dedupe_key: newlyRegistered ? "registered" : "first_seen",
    observed_at: newlyRegistered ? (row.attrs.registered ?? observedAt) : observedAt,
    title: newlyRegistered
      ? `Registered its own trucks with the DOT${row.attrs.registered ? ` on ${row.attrs.registered}` : ""}${units ? ` (${units} power units)` : ""}`
      : `Runs its own fleet${units ? `: ${units} power units` : ""}${row.attrs.drivers ? `, ${row.attrs.drivers} drivers` : ""}`,
    source_url: row.attrs.source_url,
    detail: { power_units: units, drivers: row.attrs.drivers, cargo: row.attrs.cargo },
  };
}

const APP_TOKEN = () => (process.env.SOCRATA_APP_TOKEN ? { "X-App-Token": process.env.SOCRATA_APP_TOKEN } : {});

/** One page of census records, `where` and `order` as the data site writes them */
export async function fetchPage(fetchJson, { where, order = "dot_number", limit = 5000 }) {
  const q = new URLSearchParams({ $select: FIELDS, $where: where, $order: order, $limit: String(limit) });
  return fetchJson(`${CENSUS_URL}?${q}`, { headers: APP_TOKEN() });
}

const iso = (d) => d.toISOString().slice(0, 10);
export const compact = (date) => iso(date).replace(/-/g, "");
export const today = () => iso(new Date());
