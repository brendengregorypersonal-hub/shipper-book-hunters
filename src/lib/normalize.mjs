// Small tidy-ups applied to what a public source says, so every hunter stores the same shapes.
// Collection only: nothing here decides whether a company is a good lead.

export const clean = (v) => {
  const t = String(v ?? "").replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
};

export const cleanEmail = (v) => {
  const t = clean(v)?.toLowerCase() ?? null;
  return t && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : null;
};

/** 10 digits -> "(602) 555-0100"; anything else is kept as written (or null if empty) */
export const cleanPhone = (v) => {
  const raw = clean(v);
  if (!raw) return null;
  const d = raw.replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : raw;
};

/** "ACME FOODS INC" -> "Acme Foods Inc" (names in public registers are often all capitals) */
export const tidyName = (v) => {
  const t = clean(v);
  if (!t) return null;
  if (t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/(^|[\s\-/(&])([a-z])/g, (_, a, b) => a + b.toUpperCase()).replace(/\b(Llc|Lp|Llp|Pllc)\b/g, (m) => m.toUpperCase());
};

/** The web domain of an email address or a web address ("a@b.com" / "https://www.b.com/x" -> "b.com"), never a free mail service */
const FREE_MAIL = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "live.com", "msn.com", "comcast.net", "att.net", "sbcglobal.net", "me.com", "protonmail.com"]);
export const domainOf = (v) => {
  const t = clean(v)?.toLowerCase();
  if (!t) return null;
  let host = t.includes("@") ? t.split("@").pop() : t;
  host = host.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) && !FREE_MAIL.has(host) ? host : null;
};

/** "20261026" or "2026-10-26T00:00:00.000" -> "2026-10-26", or null */
export const toDate = (v) => {
  const t = clean(v);
  if (!t) return null;
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(t);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) || d.getUTCMonth() !== Number(m[2]) - 1 ? null : `${m[1]}-${m[2]}-${m[3]}`;
};

export const toInt = (v) => {
  const n = Number(String(v ?? "").replace(/[, ]/g, ""));
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? Math.trunc(n) : null;
};
