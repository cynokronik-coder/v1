/**
 * eBay adapter - the terms-compliant, documented path (official Browse API).
 *
 * Mirrors the Python tool's adapter (src/marketwatch/adapters/ebay.py), including
 * its credential rule: without a keyset this adapter refuses to pretend. eBay is
 * the one large marketplace here with an *official* search API, which is why it is
 * the preferred resale reference for the opportunities page - and why it is worth
 * the two minutes it takes to get a free keyset.
 *
 *   token  POST https://api.ebay.com/identity/v1/oauth2/token   (client_credentials)
 *   search GET  https://api.ebay.com/buy/browse/v1/item_summary/search
 *
 * The keyset you create at https://developer.ebay.com/signin is free (5,000 calls
 * a day by default) and its keys live in this extension's own settings storage.
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

export const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
export const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
export const SCOPE = "https://api.ebay.com/oauth/api_scope";
export const DEFAULT_MARKETPLACE_ID = "EBAY_FR";
export const MAX_PER_PAGE = 200;

const ORDER_MAP = {
  [ORDER.NEWEST]: "newlyListed",
  [ORDER.PRICE_ASC]: "price",
  [ORDER.PRICE_DESC]: "-price",
};

function toFloat(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const parsed = Number(String(value).trim());
  return Number.isNaN(parsed) ? null : parsed;
}

function parseDate(raw) {
  if (typeof raw !== "string") return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Normalise an eBay `item_summary/search` payload into listings. */
export function parseEbayItems(payload, { marketplace = "ebay" } = {}) {
  const listings = [];
  for (const item of payload?.itemSummaries || []) {
    if (!item || typeof item !== "object") continue;
    const priceObj = item.price || {};
    const price = toFloat(priceObj.value);
    const itemId = item.legacyItemId || item.itemId;
    const url = item.itemWebUrl;
    if (price === null || !itemId || !url) continue;

    let landed = null;
    for (const option of item.shippingOptions || []) {
      const cost = toFloat(option?.shippingCost?.value);
      if (cost !== null) {
        landed = Math.round((price + cost) * 100) / 100;
        break;
      }
    }

    listings.push(
      makeListing({
        marketplace,
        itemId,
        title: item.title,
        url,
        price,
        currency: priceObj.currency || "EUR",
        landedPrice: landed,
        condition: item.condition || null,
        brand: item.brand || null,
        size: null,
        imageUrl: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || null,
        description: item.shortDescription || item.subtitle || null,
        favourites: null,
        createdAt: parseDate(item.itemCreationDate),
      }),
    );
  }
  return listings;
}

export function credentialsMissing({ clientId, clientSecret } = {}) {
  return !clientId || !clientSecret;
}

export function missingCredentialsError() {
  return new MarketplaceError(
    "eBay needs a free developer keyset (Client ID + Client Secret). " +
      "Create one at https://developer.ebay.com/signin, paste both into the dashboard's " +
      "Settings panel, then scan again. Nothing is sent anywhere except to eBay itself.",
  );
}

/** eBay is one request every ~4 s by default: the keyset's quota is the real limit. */
export const EBAY_PACING = Object.freeze({ minIntervalMs: 4000, jitterMs: 1500 });

export class EbayAdapter {
  name = "ebay";

  constructor({
    clientId = null,
    clientSecret = null,
    marketplaceId = DEFAULT_MARKETPLACE_ID,
    fetchImpl,
    sleep,
    random,
    pacing,
    minIntervalMs = EBAY_PACING.minIntervalMs,
    jitterMs = EBAY_PACING.jitterMs,
    maxRetries = 1,
    logger = () => {},
  } = {}) {
    if (!fetchImpl) throw new MarketplaceError("EbayAdapter needs a fetch implementation");
    this.clientId = clientId || null;
    this.clientSecret = clientSecret || null;
    this.marketplaceId = marketplaceId || DEFAULT_MARKETPLACE_ID;
    this.fetch = fetchImpl;
    this.maxRetries = maxRetries;
    this.log = logger;
    this.pacing = pacing || new Pacing({ minIntervalMs, jitterMs, sleep, random });
    this.requestsMade = 0;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  get configured() {
    return !credentialsMissing(this);
  }

  async _fetch(url, init = {}) {
    try {
      return await this.fetch(url, init);
    } catch (err) {
      throw new MarketplaceError(`request to ${url} failed: ${err.message || err}`);
    }
  }

  async applicationToken() {
    if (credentialsMissing(this)) throw missingCredentialsError();
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt - 60000) return this.token;

    await this.pacing.wait();
    const basic = btoa(`${this.clientId}:${this.clientSecret}`);
    const response = await this._fetch(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`,
    });
    this.pacing.mark();
    this.requestsMade += 1;

    if (response.status === 401 || response.status === 403) {
      throw new MarketplaceError(
        "eBay rejected the keyset (HTTP " +
          `${response.status}). Check the Client ID and Client Secret in Settings: the Client ID is ` +
          "the long application id, the secret is the private one shown once when you create it.",
      );
    }
    if (response.status !== 200) {
      throw new MarketplaceError(`eBay token request failed (HTTP ${response.status}): ${String(response.body).slice(0, 200)}`);
    }
    let payload;
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw new MarketplaceError("eBay token endpoint returned non-JSON content");
    }
    this.token = payload.access_token;
    this.tokenExpiresAt = Date.now() + Number(payload.expires_in || 7200) * 1000;
    return this.token;
  }

  buildParams(query) {
    const limit = Math.max(1, Math.min(Number(query.perPage || 96), MAX_PER_PAGE));
    const params = new URLSearchParams({
      q: query.searchText,
      limit: String(limit),
      offset: String(Math.max(0, (Math.max(1, query.page || 1) - 1) * limit)),
    });
    const sort = ORDER_MAP[query.order];
    if (sort) params.set("sort", sort);
    if (query.minPrice !== null && query.minPrice !== undefined || query.maxPrice !== null && query.maxPrice !== undefined) {
      const low = query.minPrice ?? 0;
      const high = query.maxPrice;
      const range = high === null || high === undefined ? `[${low}..]` : `[${low}..${high}]`;
      params.set("filter", `price:${range},priceCurrency:${query.currency || "EUR"}`);
    }
    for (const [key, values] of Object.entries(query.filters || {})) {
      // eBay's own filter syntax is passed straight through, e.g.
      // filters: { conditionIds: ["3000|2500"] } for used + refurbished.
      if (values?.length) params.set("filter", `${params.get("filter") ? `${params.get("filter")},` : ""}${key}:${values.join("|")}`);
    }
    return params;
  }

  async search(query) {
    const token = await this.applicationToken();
    const params = this.buildParams(query);
    const url = `${SEARCH_URL}?${params.toString()}`;
    let lastStatus = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.pacing.wait();
      const response = await this._fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": this.marketplaceId,
          Accept: "application/json",
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
          throw new MarketplaceError(`${SEARCH_URL} returned non-JSON content`);
        }
        return this._buildResult(payload, query);
      }
      if (response.status === 429) {
        const wait = retryAfterMs(response.headers) ?? this.pacing.backoffMs(attempt);
        if (attempt >= this.maxRetries) throw new MarketplaceRateLimited("eBay rate limit reached for this keyset", wait);
        await this.pacing.sleep(wait);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        this.token = null; // a stale token is the usual cause; next call refetches
        if (looksLikeChallenge(response.status, response.body, response.headers)) {
          throw new MarketplaceBlocked(`eBay refused the search (HTTP ${response.status})`);
        }
        throw new MarketplaceError(
          `eBay refused the search (HTTP ${response.status}). If the keyset is new, check that the ` +
            "Browse API scope is enabled for it.",
        );
      }
      if (response.status >= 500 && attempt < this.maxRetries) {
        await this.pacing.sleep(this.pacing.backoffMs(attempt));
        continue;
      }
      throw new MarketplaceError(`eBay search failed (HTTP ${response.status}): ${String(response.body).slice(0, 200)}`);
    }
    throw new MarketplaceError(`giving up on eBay (last HTTP ${lastStatus})`);
  }

  _buildResult(payload, query) {
    const limit = Math.max(1, Math.min(Number(query.perPage || 96), MAX_PER_PAGE));
    const total = payload?.total;
    return {
      marketplace: this.name,
      items: parseEbayItems(payload),
      page: Math.max(1, query.page || 1),
      perPage: limit,
      totalEntries: total === undefined || total === null ? null : Number(total),
      totalPages: total ? Math.ceil(Number(total) / limit) : null,
    };
  }
}
