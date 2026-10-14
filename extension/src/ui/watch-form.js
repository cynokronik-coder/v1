/**
 * The watch editor's mapping between form strings and a real watch.
 *
 * The dashboard only collects strings; validating and normalising them is the same
 * `normalizeWatch` the scanner uses, so what you save is what will run. Kept out of
 * dashboard.js so it can be tested without a browser.
 */

import { ConfigError, WATCH_DEFAULTS, normalizeWatch } from "../core/models.js";

/** "iphone 13, iphone 14" / one per line -> ["iphone 13", "iphone 14"] */
export function parseList(text) {
  if (Array.isArray(text)) return text.map((v) => String(v).trim()).filter(Boolean);
  return String(text ?? "")
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function formatList(values) {
  return (values || []).join(", ");
}

/** "30" or "30%" -> 0.3 ; "0.3" -> 0.3. The UI shows a percentage, watches store a
 *  fraction, and getting that wrong by 100x is the kind of bug nobody notices. */
export function parsePercent(value, { field = "discount" } = {}) {
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new ConfigError(`${field} is required`);
  }
  const text = String(value).trim().replace("%", "");
  const n = Number(text.replace(",", "."));
  if (Number.isNaN(n)) throw new ConfigError(`${field} must be a number, got '${value}'`);
  const fraction = n > 1 ? n / 100 : n;
  if (fraction < 0 || fraction >= 1) {
    throw new ConfigError(`${field} must be between 0 and 99% (got ${value})`);
  }
  return Math.round(fraction * 10000) / 10000;
}

export function parseOptionalNumber(value, { field }) {
  const text = String(value ?? "").trim();
  if (text === "" || text.toLowerCase() === "off" || text.toLowerCase() === "none") return null;
  const n = Number(text.replace(",", "."));
  if (Number.isNaN(n)) throw new ConfigError(`${field} must be a number, or empty for 'off' (got '${value}')`);
  return n;
}

/** Form values -> a watch the scanner will accept, or a readable error. */
export function formToWatch(values = {}, defaults = {}) {
  const marketplace = String(values.marketplace || WATCH_DEFAULTS.marketplace).toLowerCase();
  const watch = normalizeWatch(
    {
      name: values.name,
      searchText: values.searchText,
      marketplace,
      mustMatch: parseList(values.mustMatch),
      mustNotMatch: parseList(values.mustNotMatch),
      sizes: parseList(values.sizes),
      conditions: parseList(values.conditions),
      // Off only when the checkbox was explicitly unticked. New watches start
      // ticked (see blankWatchForm): "does this listing even mention my product"
      // is the question people expect a price tool to answer.
      exactPhrase: values.exactPhrase !== false,
      minDiscount: parsePercent(values.minDiscount, { field: "minimum discount" }),
      maxRobustZ: parseOptionalNumber(values.maxRobustZ, { field: "max robust z" }),
      minSampleSize: Number(String(values.minSampleSize ?? "").trim() || WATCH_DEFAULTS.minSampleSize),
      plausibleMinPrice: Number(String(values.plausibleMinPrice ?? "").trim() || WATCH_DEFAULTS.plausibleMinPrice),
      plausibleMaxPrice: Number(String(values.plausibleMaxPrice ?? "").trim() || WATCH_DEFAULTS.plausibleMaxPrice),
      samplePages: Number(String(values.samplePages ?? "").trim() || WATCH_DEFAULTS.samplePages),
      enabled: values.enabled !== false,
      acknowledgeTerms: Boolean(values.acknowledgeTerms),
      domain: values.domain || null,
    },
    defaults,
  );
  return watch;
}

/** A stored watch -> what the inputs should show. */
export function watchToForm(watch) {
  return {
    name: watch.name || "",
    marketplace: watch.marketplace || WATCH_DEFAULTS.marketplace,
    searchText: watch.searchText || "",
    mustMatch: formatList(watch.mustMatch),
    mustNotMatch: formatList(watch.mustNotMatch),
    sizes: formatList(watch.sizes),
    conditions: formatList(watch.conditions),
    exactPhrase: watch.exactPhrase === true,
    minDiscount: String(Math.round((watch.minDiscount ?? WATCH_DEFAULTS.minDiscount) * 100)),
    maxRobustZ: watch.maxRobustZ === null || watch.maxRobustZ === undefined ? "" : String(watch.maxRobustZ),
    minSampleSize: String(watch.minSampleSize ?? WATCH_DEFAULTS.minSampleSize),
    plausibleMinPrice: String(watch.plausibleMinPrice ?? WATCH_DEFAULTS.plausibleMinPrice),
    plausibleMaxPrice: String(watch.plausibleMaxPrice ?? WATCH_DEFAULTS.plausibleMaxPrice),
    samplePages: String(watch.samplePages ?? WATCH_DEFAULTS.samplePages),
    enabled: watch.enabled !== false,
    acknowledgeTerms: Boolean(watch.acknowledgeTerms),
    domain: watch.domain || "",
  };
}

export function blankWatchForm(marketplace = "vinted") {
  // A watch you create in the dashboard insists on the exact phrase from the
  // start; a watch imported from the Python tool keeps whatever it had (the model
  // default is off, because that tool has no such field).
  return watchToForm({ ...WATCH_DEFAULTS, marketplace, name: "", searchText: "", exactPhrase: true });
}
