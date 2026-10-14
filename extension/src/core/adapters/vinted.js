/**
 * Vinted adapter.
 *
 * Vinted has no public API for searching other people's listings (its official
 * "Pro Integrations" API only covers a business's own inventory), so this speaks
 * the endpoint the Vinted web app itself calls:
 *
 *     GET https://api.<domain>/svc-catalogue/items
 *
 * An anonymous session is required: GET the marketplace homepage once so the
 * browser stores its cookies, then echo the `anon_id` cookie in the `X-Anon-Id`
 * header. Without it the API answers 403 {"code":"FORBIDDEN"}.
 *
 * Everything the parser reads was taken from a real captured payload
 * (tests/fixtures/vinted_search_nike.json) and is cross-checked against the Python
 * implementation in tests/parity.test.js.
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

export const DEFAULT_DOMAIN = "vinted.fr";
const HOME_TEMPLATE = (domain) => `https://www.${domain}/`;
const API_TEMPLATE = (domain) => `https://api.${domain}/svc-catalogue/items`;
const ITEM_TEMPLATE = (domain, path) => `https://www.${domain}${path}`;

const ORDER_MAP = {
  [ORDER.RELEVANCE]: "relevance",
  [ORDER.NEWEST]: "newest_first",
  [ORDER.PRICE_ASC]: "price_low_to_high",
  [ORDER.PRICE_DESC]: "price_high_to_low",
};

/** Label keywords are localised by marketplace, e.g. on vinted.fr:
 *  "Marque: Nike, État: Neuf sans étiquette, Taille: 5 ans / 110 cm". */
const LABEL_KEYS = {
  brand: ["marque", "brand", "marca", "marke", "merk"],
  condition: ["état", "etat", "condition", "estado", "zustand", "staat"],
  size: ["taille", "size", "talla", "größe", "groesse", "maat"],
};

function toFloat(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") return value;
  const parsed = Number(String(value).trim().replace(",", "."));
  return Number.isNaN(parsed) ? null : parsed;
}

function parseLabels(item) {
  const box = item?.item_box || {};
  let brand = box.first_line || null;
  let size = null;
  let condition = null;
  const second = box.second_line;
  if (typeof second === "string" && second.trim()) {
    const parts = second.split("·").map((p) => p.trim()).filter(Boolean);
    if (parts.length) size = parts[0];
    if (parts.length > 1) condition = parts[1];
  }
  const label = box.accessibility_label;
  if (typeof label === "string") {
    for (const chunk of label.split(",")) {
      const [rawKey, ...rest] = chunk.split(":");
      if (rest.length === 0) continue;
      const key = rawKey.trim().toLowerCase();
      const value = rest.join(":").trim();
      if (!value) continue;
      for (const [field, keywords] of Object.entries(LABEL_KEYS)) {
        if (!keywords.some((k) => key.includes(k))) continue;
        if (field === "brand" && !brand) brand = value;
        else if (field === "condition" && !condition) condition = value;
        else if (field === "size" && !size) size = value;
      }
    }
  }
  return { brand, condition, size };
}

/** Turn a raw /svc-catalogue/items payload into listings. Defensive on purpose. */
export function parseItems(payload, { domain = DEFAULT_DOMAIN, marketplace = "vinted" } = {}) {
  const listings = [];
  for (const item of payload?.items || []) {
    if (!item || typeof item !== "object") continue;
    const priceObj = item.price || {};
    const price = toFloat(priceObj.amount);
    const itemId = item.id;
    if (price === null || itemId === null || itemId === undefined) continue;
    const currency = priceObj.currency_code || "EUR";
    const total = item.total_item_price || {};
    // Only trust the landed price when it is in the same currency.
    const landed = total.currency_code === currency ? toFloat(total.amount) : null;
    const labels = parseLabels(item);
    const path = item.url || `/items/${itemId}`;
    listings.push(
      makeListing({
        marketplace,
        itemId,
        title: item.title,
        url: String(path).startsWith("http") ? path : ITEM_TEMPLATE(domain, path),
        price,
        currency,
        landedPrice: landed,
        condition: labels.condition,
        brand: labels.brand,
        size: labels.size,
        imageUrl: item.photo?.url || item.photos?.[0]?.url || item.image_url || null,
        // The catalogue endpoint does not usually return a description; when a
        // payload carries one it is kept, because the exact-phrase gate reads it.
        description: item.description || item.description_short || null,
        favourites: item.favourite_count ?? null,
        createdAt: null,
        raw: item,
      }),
    );
  }
  return listings;
}

/** Spacing between requests to the same marketplace, shared by every scan. */
export const VINTED_PACING = Object.freeze({ minIntervalMs: 6000, jitterMs: 3000 });

export class VintedAdapter {
  name = "vinted";

  constructor({
    domain = DEFAULT_DOMAIN,
    fetchImpl,
    cookies,
    sleep,
    random,
    pacing,
    minIntervalMs = VINTED_PACING.minIntervalMs,
    jitterMs = VINTED_PACING.jitterMs,
    maxRetries = 3,
    logger = () => {},
  } = {}) {
    if (!fetchImpl) throw new MarketplaceError("VintedAdapter needs a fetch implementation");
    this.domain = String(domain || DEFAULT_DOMAIN).replace(/^\/+/, "");
    this.fetch = fetchImpl;
    this.cookies = cookies || (async () => null);
    this.maxRetries = maxRetries;
    this.log = logger;
    // A shared pacer means two watches on the same marketplace still leave a gap
    // between their requests, instead of restarting the clock each scan.
    this.pacing = pacing || new Pacing({ minIntervalMs, jitterMs, sleep, random });
    this.bootstrapped = false;
    this.requestsMade = 0;
  }

  /** Establish the anonymous session and expose its id to the API. */
  async bootstrap({ force = false } = {}) {
    if (this.bootstrapped && !force) return;
    const url = HOME_TEMPLATE(this.domain);
    await this.pacing.wait();
    const response = await this._fetch(url, { headers: { Accept: "text/html" } });
    this.pacing.mark();
    this.requestsMade += 1;
    if (response.status >= 400 && looksLikeChallenge(response.status, response.body, response.headers)) {
      throw this._blocked(url, response);
    }
    if (response.status >= 400) {
      throw new MarketplaceError(`${url} returned HTTP ${response.status}`);
    }
    this.anonId = await this.cookies(url, "anon_id");
    this.bootstrapped = true;
  }

  async _fetch(url, init = {}) {
    try {
      return await this.fetch(url, { credentials: "include", ...init });
    } catch (err) {
      throw new MarketplaceError(`request to ${url} failed: ${err.message || err}`);
    }
  }

  _blocked(url, response, detail) {
    const reason =
      detail ||
      (looksLikeChallenge(response.status, response.body, response.headers)
        ? "anti-bot challenge"
        : `HTTP ${response.status}`);
    return new MarketplaceBlocked(
      `${this.domain} refused the request via ${url} (${reason}). ` +
        "Slow the interval down, and see the extension README 'Terms of use'. " +
        "This extension does not solve CAPTCHAs, rotate proxies or hide who you are.",
    );
  }

  buildParams(query) {
    const params = new URLSearchParams({
      search_text: query.searchText,
      page: String(query.page || 1),
      per_page: String(query.perPage || 96),
      order: ORDER_MAP[query.order] || "relevance",
    });
    if (query.minPrice !== null && query.minPrice !== undefined) params.set("price_from", String(query.minPrice));
    if (query.maxPrice !== null && query.maxPrice !== undefined) params.set("price_to", String(query.maxPrice));
    if (query.currency) params.set("currency", query.currency);
    for (const [key, ids] of Object.entries(query.filters || {})) {
      if (ids?.length) params.set(`attribute_ids[${key}]`, ids.join(","));
    }
    return params;
  }

  /** One search, with the same 403/429/5xx discipline as the Python adapter. */
  async search(query) {
    await this.bootstrap();
    const base = API_TEMPLATE(this.domain);
    const params = this.buildParams(query);
    const url = `${base}?${params.toString()}`;
    let lastStatus = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response;
      await this.pacing.wait();
      response = await this._fetch(url, {
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
          ...(this.anonId ? { "X-Anon-Id": this.anonId } : {}),
        },
      });
      this.pacing.mark();
      this.requestsMade += 1;
      lastStatus = response.status;

      if (response.status === 200) {
        let payload;
        try {
          payload = JSON.parse(response.body);
        } catch {
          throw new MarketplaceError(
            `${base} returned non-JSON content (likely a bot challenge)`,
          );
        }
        return this._buildResult(payload, query);
      }
      if (looksLikeChallenge(response.status, response.body, response.headers)) {
        // A stale anonymous session is the usual cause; refresh it once.
        if (attempt === 0) {
          await this.bootstrap({ force: true });
          continue;
        }
        throw this._blocked(base, response);
      }
      if (response.status === 429) {
        const wait = retryAfterMs(response.headers) ?? this.pacing.backoffMs(attempt);
        if (attempt >= this.maxRetries) {
          throw new MarketplaceRateLimited(`rate limited by ${this.domain}`, wait);
        }
        await this.pacing.sleep(wait);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        if (attempt === 0) {
          await this.bootstrap({ force: true });
          continue;
        }
        throw this._blocked(base, response);
      }
      if (response.status >= 500 && attempt < this.maxRetries) {
        await this.pacing.sleep(this.pacing.backoffMs(attempt));
        continue;
      }
      throw new MarketplaceError(`${base} returned HTTP ${response.status}`);
    }
    if (lastStatus === 401 || lastStatus === 403) {
      throw this._blocked(base, { status: lastStatus, body: "", headers: new Headers() });
    }
    throw new MarketplaceError(`giving up on ${base} (last HTTP ${lastStatus})`);
  }

  _buildResult(payload, query) {
    const pagination = payload?.pagination || {};
    return {
      marketplace: this.name,
      items: parseItems(payload, { domain: this.domain }),
      page: Number(pagination.current_page || query.page || 1),
      perPage: Number(pagination.per_page || query.perPage || 0),
      totalEntries: pagination.total_entries ?? null,
      totalPages: pagination.total_pages ?? null,
    };
  }
}
