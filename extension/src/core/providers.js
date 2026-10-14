/**
 * Third-party data providers: the "connect a tool instead of scraping it myself"
 * answer.
 *
 * You bring a key; the extension calls the vendor's documented API from the
 * service worker and normalises the answer into the same listing shape the
 * marketplaces use. That gives access to the sites that have no API of their own
 * (Vinted, leboncoin, Facebook Marketplace) and to the two things no marketplace
 * will tell you: Google Shopping prices and search-interest data.
 *
 * What it does not do is pretend the vendor's service is authorisation. Apify's
 * store, Bright Data's unlocker and SerpApi's Google endpoints are third-party
 * interfaces: the source platform's terms still apply to the data. That is why
 * each provider says what it covers, and why a provider result is always labelled
 * as coming from that provider rather than from the marketplace.
 *
 * Everything here takes its `fetchImpl` as an argument, so the request shapes and
 * the parsing are tested with no network (tests/providers.test.js).
 */

import { toFloat } from "./adapters/html-extract.js";
import { parseSearchHtml } from "./adapters/html-extract.js";
import { makeListing } from "./models.js";
import { MarketplaceError } from "./adapters/base.js";
import { PROVIDERS as providerList, providerById } from "./sources.js";

export class ProviderError extends MarketplaceError {
  constructor(message) {
    super(message);
    this.name = "ProviderError";
  }
}

function trimSlash(text) {
  return String(text || "").replace(/\/+$/, "");
}

function requireKey(settings, provider) {
  const key = settings?.[provider.keySetting];
  if (!key) {
    throw new ProviderError(
      `${provider.label} needs an API key: paste it in Settings -> Data providers, then run again. ` +
        `(${provider.docsUrl})`,
    );
  }
  return key;
}

async function readJson(response, what) {
  if (response.status !== 200) {
    throw new ProviderError(`${what} failed (HTTP ${response.status}): ${String(response.body || "").slice(0, 200)}`);
  }
  try {
    return JSON.parse(response.body);
  } catch {
    throw new ProviderError(`${what} returned non-JSON content`);
  }
}

/** Any array of product-ish objects -> listings, tolerating several key names. */
export function mapProviderItems(raw, { marketplace, domain = "", source = "provider" } = {}) {
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : Array.isArray(raw?.data) ? raw.data : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const title = row.title ?? row.name ?? row.subject ?? row.itemName;
    const price = toFloat(row.price ?? row.priceEur ?? row.price_eur ?? row.amount ?? row.currentPrice);
    if (!title || price === null || price <= 0) continue;
    const url = row.url ?? row.link ?? row.itemUrl ?? row.webUrl ?? row.permalink ?? "";
    out.push(
      makeListing({
        marketplace,
        itemId: String(row.id ?? row.itemId ?? row.item_id ?? row.adId ?? url ?? `${title}|${price}`),
        title: String(title).trim(),
        url: String(url),
        price,
        currency: row.currency ?? row.priceCurrency ?? "EUR",
        condition: row.condition ?? row.state ?? null,
        brand: typeof row.brand === "string" ? row.brand : row.brand?.name ?? null,
        imageUrl: row.image ?? row.imageUrl ?? row.thumbnail ?? null,
        description: typeof row.description === "string" ? row.description : null,
        favourites: toFloat(row.favourites ?? row.favorites ?? row.favouriteCount),
        createdAt: row.createdAt ?? row.created_at ?? row.postedAt ?? null,
        sellerType: source,
      }),
    );
  }
  return out;
}

/**
 * Apify: run one actor synchronously and take its dataset as JSON.
 *
 * `run-sync-get-dataset-items` is the endpoint that returns the results in the
 * response body, which is exactly what a background worker can consume. The token
 * goes in an `Authorization: Bearer` header rather than the query string: query
 * strings end up in logs and referrers, and Apify recommends the header.
 * https://docs.apify.com/api/v2/actor-run-sync-get-dataset-items-post
 */
export async function apifyListings({
  settings,
  fetchImpl,
  marketplace,
  actor,
  query,
  maxItems = 60,
  logger = () => {},
}) {
  const provider = providerDefinition("apify");
  const token = requireKey(settings, provider);
  if (!actor) {
    throw new ProviderError(
      `Apify: no actor is configured for ${marketplace}. Pick one in Settings -> Data providers ` +
        "(for example a Vinted or leboncoin scraper from the Apify store).",
    );
  }
  // "user/actor" and "user~actor" are the same actor; the path form is the tilde one.
  const actorPath = String(actor).replace("/", "~");
  const url = `https://api.apify.com/v2/actors/${actorPath}/run-sync-get-dataset-items?limit=${maxItems}`;
  logger(`apify: running ${actor} for "${query}"`);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      search: query,
      keyword: query,
      query,
      maxItems,
      country: "FR",
      currency: "EUR",
    }),
  });
  const payload = await readJson(response, `Apify actor ${actor}`);
  return {
    marketplace,
    items: mapProviderItems(payload, { marketplace, source: "apify" }),
    provider: "apify",
    note: `Apify actor ${actor} returned ${Array.isArray(payload) ? payload.length : 0} row(s)`,
  };
}

/**
 * SerpApi: Google Shopping prices, which is the broadest resale reference there
 * is (every retailer that Google indexes) - and Google Trends interest, which is
 * the only demand signal here with a real API behind it.
 * https://serpapi.com/google-shopping-api
 */
export async function serpApiShopping({ settings, fetchImpl, query, location = "France", logger = () => {} }) {
  const provider = providerDefinition("serpapi");
  const key = requireKey(settings, provider);
  // No page-size parameter: Google Shopping's result page is a fixed size (about
  // 40 results), so asking for a different `num` would be a lie in the config.
  const url =
    `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(query)}` +
    `&location=${encodeURIComponent(location)}&hl=fr&gl=fr&api_key=${encodeURIComponent(key)}`;
  logger(`serpapi: google shopping for "${query}"`);
  const response = await fetchImpl(url, { method: "GET" });
  const payload = await readJson(response, "SerpApi Google Shopping");
  const items = mapProviderItems(
    (payload.shopping_results || []).map((row) => ({
      id: row.product_id || row.position,
      title: row.title,
      price: row.extracted_price ?? row.price,
      url: row.product_link || row.link,
      imageUrl: row.thumbnail,
      brand: row.source,
      condition: row.second_hand_condition || null,
      description: row.snippet,
    })),
    { marketplace: "google-shopping", source: "serpapi" },
  );
  return { marketplace: "google-shopping", items, provider: "serpapi" };
}

/** SerpApi Google Trends: interest over time, normalised to 0..1. */
export async function serpApiTrends({ settings, fetchImpl, query, window: windowKey = "3-m", geo = "FR", logger = () => {} }) {
  const provider = providerDefinition("serpapi");
  const key = requireKey(settings, provider);
  // Google Trends windows are spelled `today 3-m`, `today 12-m`, `today 5-y` (or
  // `now 7-d`): there is no "today 30-d"/"today 90-d" form, so the window is a word,
  // not a day count.
  const url =
    `https://serpapi.com/search.json?engine=google_trends&q=${encodeURIComponent(query)}` +
    `&data_type=TIMESERIES&date=${encodeURIComponent(`today ${windowKey}`)}&geo=${encodeURIComponent(geo)}&hl=fr` +
    `&api_key=${encodeURIComponent(key)}`;
  logger(`serpapi: google trends for "${query}"`);
  const response = await fetchImpl(url, { method: "GET" });
  const payload = await readJson(response, "SerpApi Google Trends");
  const points = payload?.interest_over_time?.timeline_data || [];
  const values = points
    .map((point) => toFloat(point?.values?.[0]?.extracted_value ?? point?.value?.[0]))
    .filter((value) => value !== null);
  if (!values.length) {
    throw new ProviderError(`SerpApi returned no trend points for "${query}"`);
  }
  // The last quarter vs the first quarter of the window: direction, not headline.
  const third = Math.max(1, Math.floor(values.length / 3));
  const first = values.slice(0, third).reduce((a, b) => a + b, 0) / third;
  const last = values.slice(-third).reduce((a, b) => a + b, 0) / third;
  const score = Math.max(0, Math.min(1, (last || 0) / 100));
  return {
    score: Math.round(score * 1000) / 1000,
    direction: last > first * 1.1 ? "rising" : last < first * 0.9 ? "falling" : "flat",
    points: values.length,
    reasons: [
      `Google Trends interest ${last > first * 1.1 ? "rising" : last < first * 0.9 ? "falling" : "flat"} ` +
        `(${Math.round(first)} -> ${Math.round(last)} over ${values.length} points)`,
    ],
  };
}

/**
 * Bright Data Web Unlocker: fetch a marketplace page from their infrastructure and
 * hand the HTML to the same extractor the rest of the extension uses.
 * https://docs.brightdata.com/api-reference/Web_Unlocker/request
 */
export async function brightDataPage({ settings, fetchImpl, marketplace, url, domain = "", logger = () => {} }) {
  const provider = providerDefinition("brightdata");
  const token = requireKey(settings, provider);
  const zone = settings?.brightDataZone;
  if (!zone) {
    throw new ProviderError(
      "Bright Data needs a zone name (the unlocker zone in your dashboard) as well as the token: " +
        "paste both in Settings -> Data providers.",
    );
  }
  logger(`brightdata: fetching ${url} via zone ${zone}`);
  const response = await fetchImpl("https://api.brightdata.com/request", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ zone, url, format: "raw" }),
  });
  if (response.status !== 200) {
    const body = String(response.body || "").slice(0, 200);
    throw new ProviderError(
      `Bright Data request failed (HTTP ${response.status})${body ? `: ${body}` : ""}. ` +
        "Check the token, the zone name and that the zone is an unlocker zone.",
    );
  }
  const { items, source } = parseSearchHtml(response.body, { marketplace, domain });
  if (!items.length) {
    throw new ProviderError(`Bright Data returned ${url} but no product data could be read from it`);
  }
  return { marketplace, items, provider: "brightdata", strategy: source };
}

export const KEEPA_DOMAIN = { fr: 4, de: 3, uk: 2, us: 1 };

/**
 * Keepa: Amazon price history by ASIN. This is the one provider that answers
 * "what did this actually sell for", because it stores history rather than a
 * snapshot. https://keepa.com/api-docs/
 */
export async function keepaPrice({ settings, fetchImpl, asin, domain = 4, logger = () => {} }) {
  const provider = providerDefinition("keepa");
  const key = requireKey(settings, provider);
  if (!asin) throw new ProviderError("Keepa needs an ASIN (the Amazon product id) to look up");
  const url = `https://api.keepa.com/product?key=${encodeURIComponent(key)}&domain=${domain}&asin=${encodeURIComponent(asin)}&stats=1`;
  logger(`keepa: ${asin} on amazon domain ${domain}`);
  const response = await fetchImpl(url, { method: "GET" });
  const payload = await readJson(response, "Keepa product lookup");
  const product = payload?.products?.[0];
  if (!product) throw new ProviderError(`Keepa knows no product with ASIN ${asin}`);
  // Keepa quotes whole cents, and index 0 of a stats pair is the *Amazon* price
  // (not the marketplace-wide lowest offer). -1 means "no data", never a price.
  const cents = (value) => (Number.isFinite(value) && value > 0 ? value / 100 : null);
  const stats = product.stats || {};
  const median = cents(stats.avg30?.[0]);
  const current = cents(stats.current?.[0]);
  const points = Array.isArray(product.csv) ? product.csv.length : 0;
  const price = current ?? median;
  if (price === null) {
    throw new ProviderError(
      `Keepa has no price history for ${asin} on Amazon domain ${domain} (that item may be out of stock or not covered)`,
    );
  }
  return {
    asin,
    title: product.title || asin,
    price,
    median30d: median,
    historyPoints: points,
    reasons: [
      `Keepa: Amazon asking price ${price.toFixed(2)} ${current === null ? "(no current price, using the 30-day average)" : ""}`.trim() +
        (median === null ? "" : `, 30-day average ${median.toFixed(2)}`),
    ],
  };
}

/** The registry definition for a provider, by id. */
function providerDefinition(id) {
  const provider = providerById(id);
  if (!provider) throw new ProviderError(`unknown data provider '${id}'`);
  return provider;
}

/**
 * An adapter-shaped shim over Apify, so a marketplace with no open tab and no
 * working search URL can still be sampled - through a vendor the user chose and
 * pays, rather than by the extension inventing a way in.
 */
export function createApifyAdapter({ settings, fetchImpl, marketplace, logger = () => {} }) {
  const actor = settings?.sources?.[marketplace]?.actor || settings?.apifyActors?.[marketplace] || null;
  return {
    name: marketplace,
    provider: "apify",
    actor,
    requestsMade: 0,
    get configured() {
      return Boolean(settings?.apifyToken && actor);
    },
    async search(query = {}) {
      const result = await apifyListings({
        settings,
        fetchImpl,
        marketplace,
        actor,
        query: query.searchText,
        maxItems: Math.max(1, Number(query.perPage) || 60),
        logger,
      });
      this.requestsMade += 1;
      return { ...result, page: 1, perPage: result.items.length, totalEntries: null, totalPages: null };
    },
  };
}

/** Provider ids whose keys are present right now, for the UI and the self-check. */
export function configuredProviders(settings = {}) {
  return providerList
    .filter((provider) => provider.keys.every((entry) => Boolean(settings[entry.key])))
    .map((provider) => provider.id);
}

export { providerList as providers };
