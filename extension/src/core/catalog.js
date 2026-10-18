/**
 * The product catalogue the opportunities page samples.
 *
 * This is the "what is worth hunting" list: categories where second-hand stock is
 * reliably underpriced on private-seller marketplaces (people clearing a drawer)
 * and reliably in demand on resale channels (refurbishers, eBay, collectors). The
 * seed is a starting point you are meant to edit - every entry is just a keyword, a
 * price band and where to look.
 *
 * Honesty about the seed: it is a *hypothesis* list, chosen because these are
 * long-lived, model-numbered products with deep second-hand markets. It is not a
 * live trend feed, and it does not claim to be. What makes it useful is that one
 * run measures each hypothesis against today's real listings and tells you which
 * ones actually cleared the margin - and the trend columns (Wikipedia interest,
 * optionally news attention, plus keywords you paste in yourself) are what move it
 * away from a static list over time.
 *
 * Fields:
 *   keyword            the search text used on both sides
 *   buyMarket          which marketplaces to sample as the acquisition side
 *   resaleSource       ebay | backmarket | manual - where the resale price comes from
 *   manualResalePrice  a price you read yourself; overrides the resale sample
 *   plausibleMin/Max   prices outside this band are not this product
 *   wikipedia          an article title used as a public-interest proxy (optional)
 *   socialKeywords     what people actually type in feeds, for the manual signal
 *   fees               optional override of the fee model (see core/opportunity.js)
 */

import { ConfigError, MARKETPLACES, RESALE_SOURCES } from "./models.js";

/** Where a catalogue entry looks by default: the two deepest private-seller markets. */
export const DEFAULT_BUY_MARKETS = ["vinted", "leboncoin"];

export const CATEGORIES = [
  "phones",
  "tablets",
  "laptops",
  "consoles",
  "pc-parts",
  "cameras",
  "audio",
  "wearables",
  "sneakers",
  "lego",
  "watches",
  "instruments",
  "tools",
  "appliances",
  "games",
  "bikes",
  "keyboards",
  "other",
];

const ITEM = (raw) => ({
  id: raw.id,
  name: raw.name,
  category: raw.category,
  keyword: raw.keyword,
  buyMarket: raw.buyMarket || DEFAULT_BUY_MARKETS,
  resaleSource: raw.resaleSource || "ebay",
  // Several resale references at once, when the product trades on more than one:
  // `core/opportunity.js` then quotes the cheapest credible one, never the best.
  resaleSources: raw.resaleSources || null,
  manualResalePrice: raw.manualResalePrice ?? null,
  plausibleMinPrice: raw.plausibleMinPrice ?? 20,
  plausibleMaxPrice: raw.plausibleMaxPrice ?? 3000,
  wikipedia: raw.wikipedia ?? null,
  socialKeywords: raw.socialKeywords || [],
  fees: raw.fees || null,
  note: raw.note || "",
  enabled: raw.enabled !== false,
});

/**
 * Per-product source coverage.
 *
 * Not every product trades on every marketplace, and a tool that samples ten sites
 * for a pair of sneakers would spend its request budget proving nothing. So each
 * product declares where it is actually worth looking: which buy-side markets and
 * which resale references. Applied over the seed below, so the seed stays readable.
 */
const COVERAGE = {
  "iphone-13": { buyMarket: ["vinted", "leboncoin", "easycash"], resaleSources: ["ebay", "backmarket", "momox", "fnac"] },
  "iphone-14-pro": { buyMarket: ["vinted", "leboncoin", "easycash"], resaleSources: ["ebay", "backmarket", "momox"] },
  "pixel-8": { buyMarket: ["vinted", "leboncoin", "easycash"], resaleSources: ["ebay", "backmarket"] },
  "ipad-air": { buyMarket: ["vinted", "leboncoin", "easycash"], resaleSources: ["ebay", "backmarket", "fnac"] },
  "macbook-air-m1": { buyMarket: ["vinted", "leboncoin", "easycash"], resaleSources: ["ebay", "backmarket", "momox"] },
  "thinkpad-t480": { buyMarket: ["vinted", "leboncoin", "cashexpress"], resaleSources: ["ebay", "backmarket"] },
  ps5: { buyMarket: ["vinted", "leboncoin", "easycash", "cashconverters"], resaleSources: ["ebay", "backmarket", "fnac"] },
  "switch-oled": { buyMarket: ["vinted", "leboncoin", "easycash"], resaleSources: ["ebay", "backmarket", "momox"] },
  "steam-deck": { buyMarket: ["vinted", "leboncoin"], resaleSources: ["ebay", "backmarket"] },
  "gameboy-color": { buyMarket: ["vinted", "leboncoin", "cashconverters"], resaleSources: ["ebay", "momox"] },
  "rtx-3060": { buyMarket: ["vinted", "leboncoin", "cashexpress"], resaleSources: ["ebay", "backmarket"] },
  "rtx-4070": { buyMarket: ["vinted", "leboncoin"], resaleSources: ["ebay", "backmarket", "cdiscount"] },
  "sony-a7iii": { buyMarket: ["vinted", "leboncoin", "cashconverters"], resaleSources: ["ebay", "backmarket", "fnac"] },
  "canon-eos-r": { buyMarket: ["vinted", "leboncoin", "cashconverters"], resaleSources: ["ebay", "backmarket", "fnac"] },
  "dji-mini": { buyMarket: ["vinted", "leboncoin"], resaleSources: ["ebay", "backmarket"] },
  "airpods-pro": { buyMarket: ["vinted", "leboncoin", "easycash"], resaleSources: ["ebay", "backmarket", "fnac"] },
  "technics-1200": { buyMarket: ["leboncoin", "cashconverters"], resaleSources: ["ebay", "momox"] },
  "seiko-skx": { buyMarket: ["vinted", "leboncoin"], resaleSources: ["ebay", "backmarket"] },
  "garmin-fenix": { buyMarket: ["vinted", "leboncoin", "easycash"], resaleSources: ["ebay", "backmarket"] },
  "nike-dunk": { buyMarket: ["vinted", "leboncoin"], resaleSources: ["ebay"] },
  "jordan-1": { buyMarket: ["vinted", "leboncoin"], resaleSources: ["ebay"] },
  "lego-technic": { buyMarket: ["vinted", "leboncoin", "momox"], resaleSources: ["ebay", "cdiscount"] },
  "lego-star-wars-ucs": { buyMarket: ["vinted", "leboncoin", "momox"], resaleSources: ["ebay"] },
  "fender-strat-mim": { buyMarket: ["leboncoin", "cashconverters"], resaleSources: ["ebay", "fnac"] },
  "makita-lxt": { buyMarket: ["leboncoin", "easycash", "cashexpress"], resaleSources: ["ebay", "fnac"] },
  "dyson-v8": { buyMarket: ["vinted", "leboncoin", "easycash"], resaleSources: ["ebay", "backmarket", "fnac"] },
  "sage-espresso": { buyMarket: ["vinted", "leboncoin"], resaleSources: ["ebay", "backmarket"] },
  "keychron-q": { buyMarket: ["vinted", "leboncoin"], resaleSources: ["ebay", "backmarket"] },
  "ebike-bosch": { buyMarket: ["leboncoin", "easycash"], resaleSources: ["ebay", "backmarket"] },
};

const RAW_CATALOG = [
  ITEM({
    id: "iphone-13",
    name: "iPhone 13 (128 / 256 Go)",
    category: "phones",
    keyword: "iphone 13 128",
    resaleSource: "backmarket",
    plausibleMinPrice: 150,
    plausibleMaxPrice: 700,
    wikipedia: "IPhone 13",
    socialKeywords: ["iphone 13", "iphone 13 reconditionné"],
    note: "the archetype: private sellers price to sell, refurbishers price to retail",
  }),
  ITEM({
    id: "iphone-14-pro",
    name: "iPhone 14 Pro",
    category: "phones",
    keyword: "iphone 14 pro",
    resaleSource: "backmarket",
    plausibleMinPrice: 350,
    plausibleMaxPrice: 1100,
    wikipedia: "IPhone 14 Pro",
  }),
  ITEM({
    id: "pixel-8",
    name: "Google Pixel 8",
    category: "phones",
    keyword: "google pixel 8",
    resaleSource: "backmarket",
    plausibleMinPrice: 180,
    plausibleMaxPrice: 700,
    wikipedia: "Pixel 8",
  }),
  ITEM({
    id: "ipad-air",
    name: "iPad Air (M1 / M2)",
    category: "tablets",
    keyword: "ipad air",
    resaleSource: "backmarket",
    plausibleMinPrice: 200,
    plausibleMaxPrice: 900,
    wikipedia: "IPad Air",
  }),
  ITEM({
    id: "macbook-air-m1",
    name: "MacBook Air M1",
    category: "laptops",
    keyword: "macbook air m1",
    resaleSource: "backmarket",
    plausibleMinPrice: 350,
    plausibleMaxPrice: 1100,
    wikipedia: "MacBook Air",
  }),
  ITEM({
    id: "thinkpad-t480",
    name: "ThinkPad T480 / T490",
    category: "laptops",
    keyword: "thinkpad t480",
    plausibleMinPrice: 150,
    plausibleMaxPrice: 700,
    wikipedia: "ThinkPad",
    note: "ex-corporate stock floods the market, business buyers still pay for them",
  }),
  ITEM({
    id: "ps5",
    name: "PlayStation 5 (slim / disc)",
    category: "consoles",
    keyword: "playstation 5",
    plausibleMinPrice: 200,
    plausibleMaxPrice: 650,
    wikipedia: "PlayStation 5",
  }),
  ITEM({
    id: "switch-oled",
    name: "Nintendo Switch OLED",
    category: "consoles",
    keyword: "nintendo switch oled",
    plausibleMinPrice: 130,
    plausibleMaxPrice: 380,
    wikipedia: "Nintendo Switch",
  }),
  ITEM({
    id: "steam-deck",
    name: "Steam Deck (LCD)",
    category: "consoles",
    keyword: "steam deck",
    plausibleMinPrice: 200,
    plausibleMaxPrice: 650,
    wikipedia: "Steam Deck",
  }),
  ITEM({
    id: "gameboy-color",
    name: "Game Boy Color + popular carts",
    category: "games",
    keyword: "game boy color",
    plausibleMinPrice: 30,
    plausibleMaxPrice: 400,
    wikipedia: "Game Boy Color",
    socialKeywords: ["gameboy", "retrogaming"],
  }),
  ITEM({
    id: "rtx-3060",
    name: "GeForce RTX 3060 / 3070",
    category: "pc-parts",
    keyword: "rtx 3060",
    plausibleMinPrice: 120,
    plausibleMaxPrice: 600,
    wikipedia: "GeForce 30 series",
  }),
  ITEM({
    id: "rtx-4070",
    name: "GeForce RTX 4070",
    category: "pc-parts",
    keyword: "rtx 4070",
    plausibleMinPrice: 300,
    plausibleMaxPrice: 900,
    wikipedia: "GeForce 40 series",
  }),
  ITEM({
    id: "sony-a7iii",
    name: "Sony A7 III body",
    category: "cameras",
    keyword: "sony a7 iii",
    plausibleMinPrice: 500,
    plausibleMaxPrice: 1800,
    socialKeywords: ["sony a7iii", "full frame mirrorless"],
  }),
  ITEM({
    id: "canon-eos-r",
    name: "Canon EOS R / RP",
    category: "cameras",
    keyword: "canon eos rp",
    plausibleMinPrice: 350,
    plausibleMaxPrice: 1400,
  }),
  ITEM({
    id: "dji-mini",
    name: "DJI Mini drone",
    category: "cameras",
    keyword: "dji mini",
    plausibleMinPrice: 150,
    plausibleMaxPrice: 1000,
    wikipedia: "DJI",
  }),
  ITEM({
    id: "airpods-pro",
    name: "AirPods Pro (2nd gen)",
    category: "audio",
    keyword: "airpods pro 2",
    resaleSource: "backmarket",
    plausibleMinPrice: 70,
    plausibleMaxPrice: 260,
    wikipedia: "AirPods Pro",
    note: "counterfeit-heavy: buy only with a serial you can check",
  }),
  ITEM({
    id: "technics-1200",
    name: "Technics SL-1200 / turntables",
    category: "audio",
    keyword: "technics sl 1200",
    plausibleMinPrice: 200,
    plausibleMaxPrice: 2500,
    wikipedia: "Technics (brand)",
  }),
  ITEM({
    id: "seiko-skx",
    name: "Seiko diver (SKX / 5)",
    category: "watches",
    keyword: "seiko skx",
    plausibleMinPrice: 80,
    plausibleMaxPrice: 900,
    wikipedia: "Seiko",
  }),
  ITEM({
    id: "garmin-fenix",
    name: "Garmin Fenix / Forerunner",
    category: "wearables",
    keyword: "garmin fenix",
    plausibleMinPrice: 100,
    plausibleMaxPrice: 800,
    wikipedia: "Garmin",
  }),
  ITEM({
    id: "nike-dunk",
    name: "Nike Dunk Low",
    category: "sneakers",
    keyword: "nike dunk low",
    plausibleMinPrice: 40,
    plausibleMaxPrice: 350,
    wikipedia: "Nike Dunk",
  }),
  ITEM({
    id: "jordan-1",
    name: "Air Jordan 1",
    category: "sneakers",
    keyword: "air jordan 1",
    plausibleMinPrice: 50,
    plausibleMaxPrice: 600,
    wikipedia: "Air Jordan",
  }),
  ITEM({
    id: "lego-technic",
    name: "LEGO Technic sets (sealed)",
    category: "lego",
    keyword: "lego technic",
    plausibleMinPrice: 20,
    plausibleMaxPrice: 600,
    wikipedia: "Lego Technic",
  }),
  ITEM({
    id: "lego-star-wars-ucs",
    name: "LEGO Star Wars UCS",
    category: "lego",
    keyword: "lego star wars ucs",
    plausibleMinPrice: 50,
    plausibleMaxPrice: 1200,
    wikipedia: "Lego Star Wars",
  }),
  ITEM({
    id: "fender-strat-mim",
    name: "Fender Stratocaster (Mexico)",
    category: "instruments",
    keyword: "fender stratocaster mexique",
    plausibleMinPrice: 300,
    plausibleMaxPrice: 1300,
    wikipedia: "Fender Stratocaster",
  }),
  ITEM({
    id: "makita-lxt",
    name: "Makita LXT tool bodies",
    category: "tools",
    keyword: "makita lxt",
    plausibleMinPrice: 40,
    plausibleMaxPrice: 500,
    wikipedia: "Makita",
  }),
  ITEM({
    id: "dyson-v8",
    name: "Dyson cordless vacuum",
    category: "appliances",
    keyword: "dyson v8",
    plausibleMinPrice: 50,
    plausibleMaxPrice: 400,
    wikipedia: "Dyson (company)",
  }),
  ITEM({
    id: "sage-espresso",
    name: "Sage / Breville espresso machine",
    category: "appliances",
    keyword: "sage barista express",
    plausibleMinPrice: 150,
    plausibleMaxPrice: 900,
    wikipedia: "Espresso machine",
  }),
  ITEM({
    id: "keychron-q",
    name: "Keychron / custom keyboards",
    category: "keyboards",
    keyword: "keychron",
    plausibleMinPrice: 40,
    plausibleMaxPrice: 400,
    wikipedia: "Keychron",
  }),
  ITEM({
    id: "ebike-bosch",
    name: "E-bike with Bosch motor",
    category: "bikes",
    keyword: "velo electrique bosch",
    plausibleMinPrice: 300,
    plausibleMaxPrice: 2500,
    wikipedia: "Electric bicycle",
  }),
];

/**
 * The catalogue the engine samples: the seed, plus each product's own coverage.
 * A product with no entry in COVERAGE keeps the seed's own `buyMarket`/`resaleSource`.
 */
export const DEFAULT_CATALOG = RAW_CATALOG.map((item) => (COVERAGE[item.id] ? { ...item, ...COVERAGE[item.id] } : item));

/** "199,90" or "199.90" -> 199.9 ; anything else -> NaN. */
function asNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return Number.NaN;
  return Number(String(value).replace(/\s/g, "").replace(",", "."));
}

/** Validate one catalogue entry, filling defaults; throws ConfigError with a readable message. */
export function normalizeCatalogItem(raw, index = 0) {
  if (!raw || typeof raw !== "object") throw new ConfigError(`catalogue entry #${index + 1} must be an object`);
  const name = String(raw.name ?? "").trim();
  const keyword = String(raw.keyword ?? "").trim();
  if (!name) throw new ConfigError(`catalogue entry #${index + 1} has no name`);
  if (!keyword) throw new ConfigError(`catalogue '${name}' has no keyword`);
  const id =
    String(raw.id ?? name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || `item-${index + 1}`;
  const min = raw.plausibleMinPrice === undefined || raw.plausibleMinPrice === "" ? 20 : asNumber(raw.plausibleMinPrice);
  const max = raw.plausibleMaxPrice === undefined || raw.plausibleMaxPrice === "" ? 3000 : asNumber(raw.plausibleMaxPrice);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    throw new ConfigError(`catalogue '${name}': plausibleMinPrice (${raw.plausibleMinPrice}) must be below plausibleMaxPrice (${raw.plausibleMaxPrice})`);
  }
  const source = String(raw.resaleSource ?? "ebay").toLowerCase();
  if (!RESALE_SOURCES.includes(source)) {
    throw new ConfigError(`catalogue '${name}': unknown resaleSource '${source}' (expected ${RESALE_SOURCES.join(" | ")})`);
  }
  // Extra resale references, deduped, always including the primary one.
  const extraResale = [].concat(raw.resaleSources || []).map((id) => String(id).toLowerCase()).filter(Boolean);
  for (const id of extraResale) {
    if (!RESALE_SOURCES.includes(id)) {
      throw new ConfigError(`catalogue '${name}': unknown resale reference '${id}' (expected ${RESALE_SOURCES.join(" | ")})`);
    }
  }
  const buyMarket = [].concat(raw.buyMarket || DEFAULT_BUY_MARKETS).map((id) => String(id).toLowerCase());
  for (const id of buyMarket) {
    if (!MARKETPLACES.includes(id)) {
      throw new ConfigError(`catalogue '${name}': unknown buyMarket '${id}' (expected ${MARKETPLACES.join(" | ")})`);
    }
  }
  const resaleSources = [...new Set([source, ...extraResale])].filter((id) => id !== "manual");
  const manualResalePrice =
    raw.manualResalePrice === null || raw.manualResalePrice === undefined || String(raw.manualResalePrice).trim() === ""
      ? null
      : asNumber(raw.manualResalePrice);
  if (manualResalePrice !== null && (!Number.isFinite(manualResalePrice) || manualResalePrice <= 0)) {
    throw new ConfigError(`catalogue '${name}': manualResalePrice must be a positive number or empty`);
  }
  return {
    id,
    name,
    category: CATEGORIES.includes(raw.category) ? raw.category : "other",
    keyword,
    buyMarket,
    resaleSource: source,
    resaleSources,
    manualResalePrice,
    // Provenance for a hand-supplied price: "you" when it was typed into the editor,
    // "assistant" when it was imported and applied from the review inbox. Not scored -
    // shown, because a price a model read somewhere and a price you read yourself
    // deserve different labels on the card even though the maths is the same.
    manualResaleSource: raw.manualResaleSource ? String(raw.manualResaleSource).slice(0, 40) : null,
    manualResaleDetail: raw.manualResaleDetail ? String(raw.manualResaleDetail).slice(0, 160) : null,
    plausibleMinPrice: min,
    plausibleMaxPrice: max,
    wikipedia: raw.wikipedia ? String(raw.wikipedia) : null,
    socialKeywords: (raw.socialKeywords || []).map((k) => String(k).trim()).filter(Boolean),
    fees: raw.fees && typeof raw.fees === "object" ? raw.fees : null,
    note: String(raw.note ?? ""),
    enabled: raw.enabled !== false,
  };
}

export function normalizeCatalog(list, { fallbackToSeed = true } = {}) {
  const raw = Array.isArray(list) && list.length ? list : fallbackToSeed ? DEFAULT_CATALOG : [];
  const items = raw.map((entry, index) => normalizeCatalogItem(entry, index));
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new ConfigError(`duplicate catalogue id: ${item.id}`);
    seen.add(item.id);
  }
  return items;
}

export function findCatalogItem(catalog, id) {
  return (catalog || []).find((item) => item.id === id) || null;
}

/** Rough size of one opportunities run, for the UI's "this will make N requests" line. */
export function estimatedRequests(catalog, { perPage = 40 } = {}) {
  const enabled = (catalog || []).filter((item) => item.enabled);
  return enabled.reduce((sum, item) => {
    const buys = (item.buyMarket || []).length;
    // Every resale reference is its own request, which is why the multi-reference
    // products are the expensive ones.
    const resaleSources = item.resaleSources || (item.resaleSource ? [item.resaleSource] : []);
    const resale = item.manualResalePrice || item.resaleSource === "manual" ? 0 : resaleSources.length;
    void perPage;
    return sum + buys + resale;
  }, 0);
}
