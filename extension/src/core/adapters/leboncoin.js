/**
 * Leboncoin adapter.
 *
 * Leboncoin has no public API for searching listings, and its robots.txt is
 * explicit: "It's forbidden to use search robots or other automatic methods to
 * access Leboncoin.fr." This adapter therefore exists for personal, low-volume
 * research only, is opt-in per watch (acknowledgeTerms), and uses the same two
 * endpoints leboncoin's own browser client uses:
 *
 *   api   POST https://api.leboncoin.fr/finder/search          (clean JSON)
 *   page  GET  https://www.leboncoin.fr/recherche?text=...     (the JSON embedded
 *         in the Next.js page)
 *
 * Both sit behind DataDome. The important difference from the Python version: the
 * request is made by *your browser*, with your real user agent and your real
 * cookies (`credentials: "include"`), so if you have visited leboncoin.fr in this
 * browser its DataDome cookie is attached automatically. A datacenter IP gets a
 * 403; a normal browsing session usually does not.
 *
 * When it is blocked anyway, we say so and stop. No proxy rotation, no CAPTCHA
 * solving, no fingerprint spoofing - on purpose.
 */

import { makeListing } from "../models.js";
import {
  ORDER,
  MarketplaceBlocked,
  MarketplaceError,
  MarketplaceRateLimited,
  Pacing,
  looksLikeChallenge,
  retryAfterMs,
} from "./base.js";

export const DEFAULT_DOMAIN = "www.leboncoin.fr";
export const FINDER_URL = "https://api.leboncoin.fr/finder/search";
export const DEFAULT_API_KEY = "ba0c2dad52b3ec"; // the public value the client ships
export const MAX_PER_PAGE = 35; // community clients use 35; larger limits are ignored
export const CURRENCY = "EUR";

const ATTR_BRAND = ["brand", "marque"];
const ATTR_SIZE = ["size", "taille", "shoe_size", "clothing_size"];
const ATTR_CONDITION = ["condition", "etat", "état", "item_condition"];
// general_sales_condition is the shipping/sales condition, so it is a last resort
const ATTR_CONDITION_FALLBACK = ["general_sales_condition"];
const SITE_BRANDS = new Set(["leboncoin", "leboncoin.fr", "www.leboncoin.fr"]);

function toFloat(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") return value;
  const parsed = Number(String(value).trim().replace(",", "."));
  return Number.isNaN(parsed) ? null : parsed;
}

/** Leboncoin wraps some scalars in single-element lists ("price": [4]). */
function first(value) {
  return Array.isArray(value) ? (value.length ? value[0] : null) : value;
}

export function parsePrice(ad) {
  const cents = toFloat(first(ad?.price_cents));
  if (cents !== null) return Math.round(cents) / 100;
  let raw = first(ad?.price);
  if (raw && typeof raw === "object") raw = raw.value ?? raw.amount;
  return toFloat(raw);
}

function attributes(ad) {
  const out = {};
  for (const attr of ad?.attributes || []) {
    if (attr && attr.key) {
      const key = String(attr.key).toLowerCase();
      if (!(key in out)) out[key] = attr;
    }
  }
  return out;
}

function attrLabel(attr) {
  if (!attr) return null;
  let label = first(attr.value_label) ?? first(attr.value);
  if (label === null || label === undefined) {
    label = Array.isArray(attr.values) && attr.values.length ? attr.values[0] : null;
  }
  if (label === null || label === undefined) return null;
  const text = String(label).trim();
  return text || null;
}

function attrOf(attrs, keys) {
  for (const key of keys) {
    const label = attrLabel(attrs[key]);
    if (label) return label;
  }
  return null;
}

/**
 * index_date / first_publication_date are Paris-local and carry no timezone, so the
 * offset has to be derived rather than assumed: Paris is UTC+1 in winter and UTC+2
 * in summer. `Intl` knows the real rule (including DST), so we ask it instead of
 * hard-coding an offset - the Python version uses zoneinfo for the same reason.
 */
function offsetMinutesFor(instantMs, timeZone = "Europe/Paris") {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = {};
  for (const part of formatter.formatToParts(new Date(instantMs))) parts[part.type] = part.value;
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return (asIfUtc - instantMs) / 60000;
}

/** Paris-local "YYYY-MM-DD HH:MM:SS" -> ISO 8601 UTC. */
export function parseDate(ad) {
  for (const field of ["index_date", "first_publication_date"]) {
    const raw = first(ad?.[field]);
    if (typeof raw !== "string" || !raw.trim()) continue;
    const text = raw.trim();
    if (/[zZ]|[+-]\d\d:?\d\d$/.test(text)) {
      const parsed = new Date(text);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
      continue;
    }
    const match = text.match(
      /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
    );
    if (!match) continue;
    const [, year, month, day, hour = "0", minute = "0", second = "0"] = match;
    const guess = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    // Resolve the offset, then re-resolve once for instants near a DST boundary.
    let utc = guess - offsetMinutesFor(guess) * 60000;
    utc = guess - offsetMinutesFor(utc) * 60000;
    return new Date(utc).toISOString();
  }
  return null;
}

/** Normalise a raw search response into listings. Defensive on purpose. */
export function parseAds(payload, { domain = DEFAULT_DOMAIN, marketplace = "leboncoin" } = {}) {
  let ads;
  if (Array.isArray(payload)) ads = payload;
  else if (payload && typeof payload === "object") ads = payload.ads || payload.items || payload.data || [];
  else ads = [];

  const listings = [];
  for (const ad of ads) {
    if (!ad || typeof ad !== "object") continue;
    const price = parsePrice(ad);
    const itemId = first(ad.list_id) ?? first(ad.id);
    if (price === null || itemId === null || itemId === undefined) continue;

    const attrs = attributes(ad);
    let url = ad.url;
    if (typeof url !== "string" || !url.trim()) {
      url = `https://${domain}/ad/${first(ad.category_id) ?? 0}/${itemId}`;
    } else if (url.startsWith("/")) {
      url = `https://${domain}${url}`;
    }

    let brand = attrOf(attrs, ATTR_BRAND);
    if (!brand && typeof ad.brand === "string" && ad.brand.trim() && !SITE_BRANDS.has(ad.brand.trim().toLowerCase())) {
      brand = ad.brand.trim();
    }

    const counters = ad.counters && typeof ad.counters === "object" ? ad.counters : {};
    const owner = ad.owner && typeof ad.owner === "object" ? ad.owner : {};
    const location = ad.location && typeof ad.location === "object" ? ad.location : {};
    const images = ad.images && typeof ad.images === "object" ? ad.images : {};

    listings.push(
      makeListing({
        marketplace,
        itemId,
        title: String(ad.subject || "").trim(),
        url,
        price,
        currency: CURRENCY,
        condition: attrOf(attrs, ATTR_CONDITION) || attrOf(attrs, ATTR_CONDITION_FALLBACK),
        brand,
        size: attrOf(attrs, ATTR_SIZE),
        imageUrl: images.thumb_url || images.small_url || (Array.isArray(images.urls) ? images.urls[0] : null) || null,
        favourites: Number.isInteger(counters.favorites) ? counters.favorites : null,
        createdAt: parseDate(ad),
        sellerType: owner.type || null,
        raw: { zipcode: location.zipcode, city: location.city, adType: ad.ad_type, status: ad.status },
      }),
    );
  }
  return listings;
}

/**
 * Pull the ads out of the JSON the Next.js search page embeds. The exact path
 * moves between releases, so instead of hard-coding it we walk the tree and keep
 * the first list whose entries look like ads.
 */
export function findAdsInPage(html) {
  const match = String(html || "").match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match) return [];
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return [];
  }
  return searchAdsList(data, 0) || [];
}

function searchAdsList(node, depth) {
  if (depth > 12 || node === null || node === undefined) return null;
  if (Array.isArray(node)) {
    if (node.length && node.every((x) => x && typeof x === "object") && node.some((x) => "list_id" in x)) {
      return node.filter((x) => x && typeof x === "object");
    }
    for (const item of node) {
      const found = searchAdsList(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === "object") {
    for (const key of ["ads", "items", "results"]) {
      const found = searchAdsList(node[key], depth + 1);
      if (found) return found;
    }
    for (const value of Object.values(node)) {
      const found = searchAdsList(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function blockedAdvice(hasDatadomeCookie) {
  return (
    "Run it from a normal browser session and slow the interval down. " +
    (hasDatadomeCookie
      ? "A DataDome cookie is present, so this session has already been challenged; opening leboncoin.fr in a tab and browsing a couple of pages usually clears it."
      : "Open leboncoin.fr in this browser once (and browse a couple of pages) so the extension shares a real session with it.") +
    " This extension does not solve CAPTCHAs, rotate proxies or hide who you are."
  );
}

/** Spacing between requests to the same marketplace, shared by every scan.
 *  Slower than Vinted on purpose: leboncoin sits behind DataDome. */
export const LEBONCOIN_PACING = Object.freeze({ minIntervalMs: 8000, jitterMs: 4000 });

export class LeboncoinAdapter {
  name = "leboncoin";

  constructor({
    domain = DEFAULT_DOMAIN,
    transport = "auto",
    apiKey = DEFAULT_API_KEY,
    fetchImpl,
    cookies,
    sleep,
    random,
    pacing,
    minIntervalMs = LEBONCOIN_PACING.minIntervalMs,
    jitterMs = LEBONCOIN_PACING.jitterMs,
    maxRetries = 2,
    logger = () => {},
  } = {}) {
    if (!fetchImpl) throw new MarketplaceError("LeboncoinAdapter needs a fetch implementation");
    this.domain = String(domain || DEFAULT_DOMAIN).replace(/^\/+/, "");
    this.transport = String(transport || "auto").toLowerCase();
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.cookies = cookies || (async () => null);
    this.maxRetries = maxRetries;
    this.log = logger;
    // A shared pacer means two watches on the same marketplace still leave a gap
    // between their requests, instead of restarting the clock each scan.
    this.pacing = pacing || new Pacing({ minIntervalMs, jitterMs, sleep, random });
    this.requestsMade = 0;
    this.datadomeCookie = null;
  }

  _origin() {
    return `https://${this.domain}`;
  }

  async _fetch(url, init = {}) {
    try {
      return await this.fetch(url, { credentials: "include", ...init });
    } catch (err) {
      throw new MarketplaceError(`request to ${url} failed: ${err.message || err}`);
    }
  }

  async _noteCookies() {
    // Presence of this cookie tells us the session has already been challenged.
    this.datadomeCookie = await this.cookies(this._origin(), "datadome");
  }

  _blocked(url, response, reason) {
    const detail =
      reason || (looksLikeChallenge(response.status, response.body, response.headers) ? "DataDome challenge" : `HTTP ${response.status}`);
    return new MarketplaceBlocked(
      `${url} refused (${detail}). ${blockedAdvice(Boolean(this.datadomeCookie))}`,
    );
  }

  /** One guarded request with retries, shared by both transports. */
  async _request(url, init, label) {
    let lastStatus = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.pacing.wait();
      const response = await this._fetch(url, init);
      this.pacing.mark();
      this.requestsMade += 1;
      lastStatus = response.status;

      if (response.status === 200) return response;
      if (looksLikeChallenge(response.status, response.body, response.headers)) {
        throw this._blocked(label, response);
      }
      if (response.status === 401 || response.status === 403) {
        // refresh the session view once, then stop
        if (attempt === 0) {
          await this._noteCookies();
          continue;
        }
        throw this._blocked(label, response);
      }
      if (response.status === 429) {
        const wait = retryAfterMs(response.headers) ?? this.pacing.backoffMs(attempt);
        if (attempt >= this.maxRetries) throw new MarketplaceRateLimited(`rate limited by ${this.domain}`, wait);
        await this.pacing.sleep(wait);
        continue;
      }
      if (response.status >= 500 && attempt < this.maxRetries) {
        await this.pacing.sleep(this.pacing.backoffMs(attempt));
        continue;
      }
      throw new MarketplaceError(`${label} returned HTTP ${response.status}`);
    }
    if (lastStatus === 401 || lastStatus === 403) {
      throw this._blocked(label, { status: lastStatus, body: "", headers: new Headers() });
    }
    throw new MarketplaceError(`giving up on ${label} (last HTTP ${lastStatus})`);
  }

  // --- request shapes ------------------------------------------------------

  limit(query) {
    return Math.max(1, Math.min(Number(query.perPage || MAX_PER_PAGE), MAX_PER_PAGE));
  }

  static filterValues(query, ...names) {
    const out = [];
    for (const [key, values] of Object.entries(query.filters || {})) {
      if (names.includes(key.trim().toLowerCase())) {
        for (const v of values || []) if (String(v).trim()) out.push(String(v));
      }
    }
    return out;
  }

  locationFilters(query) {
    const location = {};
    const map = [
      [["regions", "region"], "regions"],
      [["departments", "department"], "departments"],
      [["city_zipcodes", "zipcodes", "zipcode"], "zip_codes"],
    ];
    for (const [keys, field] of map) {
      const values = LeboncoinAdapter.filterValues(query, ...keys);
      if (values.length) location[field] = [...(location[field] || []), ...values];
    }
    return location;
  }

  /** POST body for /finder/search. Prices in the filter are in cents. */
  buildBody(query) {
    const limit = this.limit(query);
    const filters = { keywords: { text: query.searchText } };

    const adTypes = LeboncoinAdapter.filterValues(query, "ad_type");
    const enums = { ad_type: adTypes.length ? adTypes : ["offer"] };
    const ownerTypes = LeboncoinAdapter.filterValues(query, "owner_type", "seller_type");
    if (ownerTypes.length) enums.owner_type = ownerTypes;
    filters.enums = enums;

    const categories = LeboncoinAdapter.filterValues(query, "category", "category_id");
    if (categories.length) filters.category = { id: categories[0] };

    const location = this.locationFilters(query);
    if (Object.keys(location).length) filters.location = location;

    const price = {};
    if (query.minPrice !== null && query.minPrice !== undefined) price.min = Math.round(query.minPrice * 100);
    if (query.maxPrice !== null && query.maxPrice !== undefined) price.max = Math.round(query.maxPrice * 100);
    if (Object.keys(price).length) filters.ranges = { price };

    const body = { limit, offset: (Math.max(1, query.page || 1) - 1) * limit, filters };
    const sorting = {
      [ORDER.RELEVANCE]: null,
      [ORDER.NEWEST]: ["time", "desc"],
      [ORDER.PRICE_ASC]: ["price", "asc"],
      [ORDER.PRICE_DESC]: ["price", "desc"],
    }[query.order];
    if (sorting) {
      body.sort_by = sorting[0];
      body.sort_order = sorting[1];
    }
    return body;
  }

  /** Search-page URL for the `page` transport. Prices here are in euros. */
  searchUrl(query) {
    const params = new URLSearchParams({ text: query.searchText, page: String(Math.max(1, query.page || 1)) });
    if (query.minPrice !== null && query.minPrice !== undefined || query.maxPrice !== null && query.maxPrice !== undefined) {
      const low = query.minPrice === null || query.minPrice === undefined ? "" : String(query.minPrice);
      const high = query.maxPrice === null || query.maxPrice === undefined ? "" : String(query.maxPrice);
      params.set("price", `${low}-${high}`);
    }
    if (query.order === ORDER.NEWEST) {
      params.set("sort", "time");
      params.set("order", "desc");
    } else if (query.order === ORDER.PRICE_ASC) {
      params.set("sort", "price");
      params.set("order", "asc");
    } else if (query.order === ORDER.PRICE_DESC) {
      params.set("sort", "price");
      params.set("order", "desc");
    }
    for (const [key, values] of Object.entries(query.filters || {})) {
      const low = key.trim().toLowerCase();
      if ((low === "category" || low === "category_id") && values?.length) params.set("category", String(values[0]));
      else if ((low === "regions" || low === "region" || low === "departments" || low === "department") && values?.length) {
        params.set("locations", values.map(String).join(","));
      }
    }
    params.set("limit", String(this.limit(query)));
    return `https://${this.domain}/recherche?${params.toString()}`;
  }

  // --- transports ----------------------------------------------------------

  async _searchApi(query) {
    const body = this.buildBody(query);
    const response = await this._request(
      FINDER_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8", api_key: this.apiKey, Accept: "application/json" },
        body: JSON.stringify(body),
      },
      FINDER_URL,
    );
    let payload;
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw new MarketplaceError(`${FINDER_URL} returned non-JSON content (likely a bot challenge)`);
    }
    return this._buildResult(payload, query);
  }

  async _searchPage(query) {
    const url = this.searchUrl(query);
    const response = await this._request(url, { headers: { Accept: "text/html" } }, url);
    const ads = findAdsInPage(response.body);
    if (!ads.length) {
      throw new MarketplaceError(
        `${url} returned HTTP 200 but no embedded listing JSON was found ` +
          "(the page markup probably changed, or an interstitial was served)",
      );
    }
    return this._buildResult({ ads }, query);
  }

  _transports() {
    return this.transport === "api" || this.transport === "page" ? [this.transport] : ["api", "page"];
  }

  async search(query) {
    await this._noteCookies();
    const failures = [];
    const transports = this._transports();
    for (let index = 0; index < transports.length; index += 1) {
      const transport = transports[index];
      try {
        const result = transport === "api" ? await this._searchApi(query) : await this._searchPage(query);
        result.items = this.postFilter(result.items, query);
        return result;
      } catch (err) {
        if (err instanceof MarketplaceRateLimited) throw err;
        if (!(err instanceof MarketplaceBlocked)) throw err;
        failures.push(`${transport}: ${err.message}`);
        if (index === transports.length - 1) break;
      }
    }
    throw new MarketplaceBlocked(
      `${this.domain} refused every transport: ${failures.join("; ")}`,
    );
  }

  /**
   * Client-side guards for what the request body cannot always express.
   * sellerType is dropped only when it is stated and contradicts the filter: a
   * field that disappears from the response must not empty the whole pool.
   */
  postFilter(items, query) {
    const adTypes = new Set(LeboncoinAdapter.filterValues(query, "ad_type").map((t) => t.toLowerCase()));
    if (!adTypes.size) adTypes.add("offer");
    const ownerTypes = new Set(LeboncoinAdapter.filterValues(query, "owner_type", "seller_type").map((t) => t.toLowerCase()));
    return items.filter((item) => {
      const meta = item.raw || {};
      if (meta.adType && !adTypes.has(String(meta.adType).toLowerCase())) return false;
      if (meta.status && !["", "active"].includes(String(meta.status).toLowerCase())) return false;
      const seller = String(item.sellerType || "").toLowerCase();
      if (ownerTypes.size && seller && !ownerTypes.has(seller)) return false;
      return true;
    });
  }

  _buildResult(payload, query) {
    const pagination = payload && typeof payload === "object" && payload.pagination ? payload.pagination : {};
    const total = payload && typeof payload === "object" ? payload.total ?? pagination.total : null;
    return {
      marketplace: this.name,
      items: parseAds(payload, { domain: this.domain }),
      page: Math.max(1, query.page || 1),
      perPage: this.limit(query),
      totalEntries: Number.isInteger(total) ? total : null,
      totalPages:
        payload && typeof payload === "object" && Number.isInteger(payload.max_pages)
          ? payload.max_pages
          : pagination.max_pages ?? null,
    };
  }
}
