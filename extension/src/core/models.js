/**
 * Data shapes shared by adapters, the analyzer, the scanner and the UI.
 *
 * Watch keys accept both this extension's camelCase and the Python tool's
 * snake_case (min_discount, plausible_min_price, ...), so a config written for one
 * can be pasted into the other.
 */

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

export const MARKETPLACES = ["vinted", "leboncoin", "mock"];

/** Marketplaces whose endpoints are unofficial: these need acknowledgeTerms. */
export const UNOFFICIAL_MARKETPLACES = {
  vinted:
    "Vinted has no public API for searching other people's listings; this uses the " +
    "endpoint its own web app calls. Vinted's terms forbid scraping/bots, so keep it " +
    "to personal, low-volume research on your own responsibility.",
  leboncoin:
    "Leboncoin has no public API for searching listings and its robots.txt forbids " +
    "'search robots or other automatic methods'. This extension uses the same " +
    "endpoints its own browser client calls, from your own browser session. Personal, " +
    "low-volume use only.",
};

function pick(obj, ...keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function asArray(value, fallback = []) {
  if (value === undefined || value === null) return fallback;
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v !== "");
  return [String(value)];
}

function asNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (Number.isNaN(n)) throw new ConfigError(`expected a number, got ${JSON.stringify(value)}`);
  return n;
}

export const WATCH_DEFAULTS = {
  marketplace: "vinted",
  domain: null,
  filters: {},
  mustMatch: [],
  mustNotMatch: [],
  conditions: [],
  sizes: [],
  plausibleMinPrice: 5,
  plausibleMaxPrice: 5000,
  samplePages: 3,
  minSampleSize: 8,
  minDiscount: 0.3,
  maxRobustZ: -1.0,
  compsTtlSeconds: 900,
  enabled: true,
  acknowledgeTerms: false,
};

/** Validate + fill defaults. `defaults` mirrors watches.yaml's `defaults:` block. */
export function normalizeWatch(raw, defaults = {}, index = 0) {
  if (!raw || typeof raw !== "object") throw new ConfigError(`watch #${index + 1} must be an object`);
  const merged = { ...defaults, ...raw };
  const name = String(pick(merged, "name") ?? "").trim();
  if (!name) throw new ConfigError(`watch #${index + 1} has no name`);
  const searchText = String(pick(merged, "searchText", "search_text") ?? "").trim();
  if (!searchText) throw new ConfigError(`watch '${name}' has no searchText`);

  const marketplace = String(pick(merged, "marketplace") ?? WATCH_DEFAULTS.marketplace).toLowerCase();
  if (!MARKETPLACES.includes(marketplace)) {
    throw new ConfigError(`watch '${name}': unknown marketplace '${marketplace}' (expected ${MARKETPLACES.join(" | ")})`);
  }

  let maxRobustZ = pick(merged, "maxRobustZ", "max_robust_z");
  maxRobustZ = maxRobustZ === undefined || maxRobustZ === "null" ? null : asNumber(maxRobustZ, WATCH_DEFAULTS.maxRobustZ);

  const rawFilters = pick(merged, "filters") ?? {};
  const filters = {};
  for (const [key, value] of Object.entries(rawFilters)) filters[key] = asArray(value);

  const watch = {
    name,
    searchText,
    marketplace,
    domain: pick(merged, "domain") ?? null,
    filters,
    mustMatch: asArray(pick(merged, "mustMatch", "must_match")),
    mustNotMatch: asArray(pick(merged, "mustNotMatch", "must_not_match")),
    conditions: asArray(pick(merged, "conditions")),
    sizes: asArray(pick(merged, "sizes")),
    plausibleMinPrice: asNumber(pick(merged, "plausibleMinPrice", "plausible_min_price"), WATCH_DEFAULTS.plausibleMinPrice),
    plausibleMaxPrice: asNumber(pick(merged, "plausibleMaxPrice", "plausible_max_price"), WATCH_DEFAULTS.plausibleMaxPrice),
    samplePages: Math.max(1, asNumber(pick(merged, "samplePages", "sample_pages"), WATCH_DEFAULTS.samplePages)),
    minSampleSize: Math.max(1, asNumber(pick(merged, "minSampleSize", "min_sample_size"), WATCH_DEFAULTS.minSampleSize)),
    minDiscount: asNumber(pick(merged, "minDiscount", "min_discount"), WATCH_DEFAULTS.minDiscount),
    maxRobustZ,
    compsTtlSeconds: asNumber(pick(merged, "compsTtlSeconds", "comps_ttl_seconds"), WATCH_DEFAULTS.compsTtlSeconds),
    enabled: pick(merged, "enabled") === undefined ? true : Boolean(pick(merged, "enabled")),
    acknowledgeTerms: Boolean(pick(merged, "acknowledgeTerms", "acknowledge_terms")),
  };

  if (watch.plausibleMinPrice >= watch.plausibleMaxPrice) {
    throw new ConfigError(
      `watch '${name}': plausibleMinPrice (${watch.plausibleMinPrice}) must be below plausibleMaxPrice (${watch.plausibleMaxPrice})`,
    );
  }
  if (watch.minDiscount < 0 || watch.minDiscount >= 1) {
    throw new ConfigError(`watch '${name}': minDiscount must be a fraction between 0 and 1 (got ${watch.minDiscount})`);
  }
  return watch;
}

export function normalizeWatches(rawList, defaults = {}) {
  if (!Array.isArray(rawList)) throw new ConfigError("watches must be a list");
  const watches = rawList.map((raw, index) => normalizeWatch(raw, defaults, index));
  const seen = new Set();
  for (const watch of watches) {
    if (seen.has(watch.name)) throw new ConfigError(`duplicate watch name: ${watch.name}`);
    seen.add(watch.name);
  }
  return watches;
}

/** One normalised marketplace listing. */
export function makeListing({
  marketplace,
  itemId,
  title,
  url,
  price,
  currency,
  landedPrice = null,
  condition = null,
  brand = null,
  size = null,
  imageUrl = null,
  favourites = null,
  createdAt = null,
  sellerType = null,
  raw = null,
}) {
  return {
    marketplace: String(marketplace),
    itemId: String(itemId),
    title: String(title ?? "").trim(),
    url: String(url ?? ""),
    price: Number(price),
    currency: String(currency || "EUR"),
    landedPrice: landedPrice === null ? null : Number(landedPrice),
    condition: condition || null,
    brand: brand || null,
    size: size || null,
    imageUrl: imageUrl || null,
    favourites: favourites === null ? null : Number(favourites),
    createdAt: createdAt || null,
    sellerType: sellerType || null,
    raw,
  };
}

/** Strip `raw` before persisting: marketplace payloads are large and are only
 *  useful while the response is in hand. */
export function slimListing(listing) {
  return {
    marketplace: listing.marketplace,
    itemId: listing.itemId,
    title: listing.title,
    url: listing.url,
    price: listing.price,
    currency: listing.currency,
    landedPrice: listing.landedPrice ?? null,
    condition: listing.condition ?? null,
    brand: listing.brand ?? null,
    size: listing.size ?? null,
    imageUrl: listing.imageUrl ?? null,
    favourites: listing.favourites ?? null,
    createdAt: listing.createdAt ?? null,
  };
}

export function listingKey(listing) {
  return `${listing.marketplace}:${listing.itemId}`;
}

/** Deal identity: the same item can be a deal for two different watches. */
export function dealKey(deal) {
  return `${deal.watch}|${deal.listing.marketplace}|${deal.listing.itemId}`;
}
