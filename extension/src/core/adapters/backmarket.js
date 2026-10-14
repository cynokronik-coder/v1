/**
 * Back Market - resale-reference adapter (refurbished asking prices).
 *
 * Read this before trusting it. Back Market publishes **no** public API for
 * keyword search: the only documented API is the seller API (own listings and
 * per-listing competitor data, behind a seller token). Its consumer search page is
 * served behind Cloudflare, and its front-end loads results through an internal
 * search request that is undocumented and free to change at any time.
 *
 * So this adapter does the honest version of that job:
 *
 *   1. it asks the user's own Back Market tab to fetch the search page (same tab
 *      transport as leboncoin - a real session, not a forged one);
 *   2. it reads the product data the page embeds (JSON-LD `ItemList`, then the
 *      site's own embedded JSON payload);
 *   3. when it cannot read it - changed markup, Cloudflare interstitial, no data -
 *      it **throws and says so**. It never invents a price. A resale reference
 *      that is silently wrong is worse than no reference at all.
 *
 * The opportunities page therefore treats Back Market as optional: a manual resale
 * price per product always works, and `ebay` (official API) is the preferred
 * reference. See core/opportunity.js.
 */

import { makeListing } from "../models.js";
import { Pacing, MarketplaceBlocked, MarketplaceError, looksLikeChallenge } from "./base.js";

export const DEFAULT_DOMAIN = "www.backmarket.fr";
export const DEFAULT_LOCALE = "fr-fr";

const TITLE_KEYS = ["name", "title", "productName", "label", "model"];
const PRICE_KEYS = ["price", "minPrice", "amount", "bestPrice", "priceWithTax"];
// Nested containers worth descending into before giving up on a payload.
const PRODUCT_CONTAINERS = ["products", "hits", "items", "results", "productList", "offers"];

function toFloat(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value).replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isNaN(parsed) ? null : parsed;
}

function titleOf(node) {
  for (const key of TITLE_KEYS) {
    const value = node[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function priceOf(node) {
  for (const key of PRICE_KEYS) {
    const value = toFloat(node[key]);
    if (value !== null && value > 0) return value;
  }
  return null;
}

/** Does this object look like one product with a title and a price? */
function looksLikeProduct(node) {
  return titleOf(node) !== null && priceOf(node) !== null;
}

/** Collect every product-shaped object in an arbitrary JSON payload (depth-first). */
export function collectProducts(node, { depth = 0, out = [], limit = 200 } = {}) {
  if (out.length >= limit || depth > 14 || node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collectProducts(item, { depth: depth + 1, out, limit });
    return out;
  }
  if (looksLikeProduct(node)) {
    out.push(node);
    return out;
  }
  const preferred = PRODUCT_CONTAINERS.filter((key) => key in node);
  for (const value of preferred.map((key) => node[key])) collectProducts(value, { depth: depth + 1, out, limit });
  for (const [key, value] of Object.entries(node)) {
    if (PRODUCT_CONTAINERS.includes(key)) continue;
    if (key.startsWith("@")) continue;
    collectProducts(value, { depth: depth + 1, out, limit });
    if (out.length >= limit) break;
  }
  return out;
}

export function extractJsonLd(html) {
  const blocks = [...String(html || "").matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const parsed = [];
  for (const [, text] of blocks) {
    try {
      parsed.push(JSON.parse(text));
    } catch {
      /* a malformed block is not a reason to give up on the others */
    }
  }
  return parsed;
}

export function extractEmbeddedJson(html) {
  const text = String(html || "");
  const payloads = [];
  for (const id of ["__NUXT_DATA__", "__NEXT_DATA__"]) {
    const match = text.match(new RegExp(`<script id="${id}"[^>]*>([\\s\\S]*?)</script>`));
    if (!match) continue;
    try {
      payloads.push(JSON.parse(match[1]));
    } catch {
      /* ignore */
    }
  }
  return payloads;
}

const CONDITION_BY_LD = {
  "http://schema.org/RefurbishedCondition": "reconditionné",
  "https://schema.org/RefurbishedCondition": "reconditionné",
  "http://schema.org/UsedCondition": "occasion",
  "https://schema.org/UsedCondition": "occasion",
  "http://schema.org/NewCondition": "neuf",
  "https://schema.org/NewCondition": "neuf",
};

function offerPrice(offer) {
  if (!offer || typeof offer !== "object") return null;
  return (
    toFloat(offer.price) ??
    toFloat(offer.lowPrice) ??
    toFloat(offer.priceSpecification?.price) ??
    (Array.isArray(offer.offers) ? offerPrice(offer.offers[0]) : null)
  );
}

/** JSON-LD ItemList / Product graphs -> listings. */
export function listingsFromJsonLd(payloads, { domain = DEFAULT_DOMAIN, marketplace = "backmarket" } = {}) {
  const listings = [];
  const seen = new Set();

  const visit = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 10) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const types = [].concat(node["@type"] || []);
    if (types.includes("ItemList")) {
      for (const element of node.itemListElement || []) visit(element?.item || element, depth + 1);
    }
    if (types.includes("Product")) {
      const price = offerPrice(node.offers) ?? toFloat(node.offers?.price);
      const url = typeof node.url === "string" ? node.url : null;
      const id = node.sku || node.mpn || url;
      const title = typeof node.name === "string" ? node.name.trim() : "";
      if (price !== null && price > 0 && title && id && !seen.has(id)) {
        seen.add(id);
        const conditionRaw = [].concat(node.offers?.itemCondition || node.itemCondition || [])[0];
        listings.push(
          makeListing({
            marketplace,
            itemId: String(id),
            title,
            url: url && url.startsWith("http") ? url : `https://${domain}/`,
            price,
            currency: node.offers?.priceCurrency || "EUR",
            condition: CONDITION_BY_LD[conditionRaw] || null,
            brand: typeof node.brand === "string" ? node.brand : node.brand?.name || null,
            imageUrl: [].concat(node.image || [])[0] || null,
            description: typeof node.description === "string" ? node.description : null,
          }),
        );
      }
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };

  for (const payload of payloads) visit(payload);
  return listings;
}

/**
 * Everything a Back Market search page can give us, in order of trust:
 * JSON-LD first, then the site's own embedded payload (best-effort walk).
 */
export function parseBackMarketHtml(html, { domain = DEFAULT_DOMAIN } = {}) {
  const fromLd = listingsFromJsonLd(extractJsonLd(html), { domain });
  if (fromLd.length) return { items: fromLd, source: "json-ld" };

  const products = [];
  const seenTitles = new Set();
  for (const payload of extractEmbeddedJson(html)) {
    for (const node of collectProducts(payload)) {
      const title = titleOf(node);
      const price = priceOf(node);
      if (!title || price === null || seenTitles.has(`${title}|${price}`)) continue;
      seenTitles.add(`${title}|${price}`);
      const url = [node.url, node.slug, node.href].find((v) => typeof v === "string" && v.trim());
      products.push(
        makeListing({
          marketplace: "backmarket",
          itemId: node.id || node.sku || `${title}|${price}`,
          title,
          url: url
            ? url.startsWith("http")
              ? url
              : `https://${domain}${url.startsWith("/") ? "" : "/"}${url}`
            : `https://${domain}/`,
          price,
          currency: node.currency || node.priceCurrency || "EUR",
          condition: typeof node.condition === "string" ? node.condition : "reconditionné",
          brand: typeof node.brand === "string" ? node.brand : node.brand?.name || null,
          imageUrl: node.image || node.imageUrl || node.thumbnail || null,
        }),
      );
    }
    if (products.length) break;
  }
  return { items: products, source: products.length ? "embedded-json" : null };
}

export const BACKMARKET_PACING = Object.freeze({ minIntervalMs: 8000, jitterMs: 4000 });

export class BackMarketAdapter {
  name = "backmarket";

  constructor({
    domain = DEFAULT_DOMAIN,
    locale = DEFAULT_LOCALE,
    fetchImpl,
    tabTransport = null,
    sleep,
    random,
    pacing,
    minIntervalMs = BACKMARKET_PACING.minIntervalMs,
    jitterMs = BACKMARKET_PACING.jitterMs,
    maxRetries = 0,
    logger = () => {},
  } = {}) {
    if (!fetchImpl) throw new MarketplaceError("BackMarketAdapter needs a fetch implementation");
    this.domain = String(domain || DEFAULT_DOMAIN).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    this.locale = locale;
    this.fetch = fetchImpl;
    this.tabTransport = tabTransport;
    this.maxRetries = maxRetries;
    this.log = logger;
    this.pacing = pacing || new Pacing({ minIntervalMs, jitterMs, sleep, random });
    this.requestsMade = 0;
    this.lastSource = null;
  }

  searchUrl(query) {
    return `https://${this.domain}/${this.locale}/search?q=${encodeURIComponent(query.searchText)}`;
  }

  async _tabReady() {
    if (!this.tabTransport?.available) return false;
    try {
      return Boolean(await this.tabTransport.available([this.domain]));
    } catch {
      return false;
    }
  }

  async _fetch(url) {
    if (await this._tabReady()) {
      try {
        this.lastSource = "tab";
        return await this.tabTransport.fetchInTab(url, { credentials: "include", headers: { Accept: "text/html" } }, { hosts: [this.domain] });
      } catch (err) {
        this.log(`backmarket tab transport failed: ${err.message || err}`);
      }
    }
    this.lastSource = "service worker";
    try {
      return await this.fetch(url, { credentials: "include", headers: { Accept: "text/html" } });
    } catch (err) {
      throw new MarketplaceError(`request to ${url} failed: ${err.message || err}`);
    }
  }

  async search(query) {
    const url = this.searchUrl(query);
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.pacing.wait();
      const response = await this._fetch(url);
      this.pacing.mark();
      this.requestsMade += 1;

      if (response.status === 200) {
        const { items, source } = parseBackMarketHtml(response.body, { domain: this.domain });
        if (items.length) {
          this.lastSource = source;
          return {
            marketplace: this.name,
            items,
            page: 1,
            perPage: items.length,
            totalEntries: items.length,
            totalPages: 1,
            source,
          };
        }
        throw new MarketplaceError(
          `${url} returned HTTP 200 but no product data could be read from it ` +
            "(Back Market's markup changed, or an interstitial was served). " +
            "Enter a manual resale price for this product instead - see the opportunities page.",
        );
      }
      if (looksLikeChallenge(response.status, response.body, response.headers)) {
        throw new MarketplaceBlocked(
          `Back Market refused the request (HTTP ${response.status}, bot protection). ` +
            "Open backmarket.fr in a normal tab so the extension can use that tab's session, or " +
            "enter a manual resale price. This extension does not solve CAPTCHAs or hide who you are.",
        );
      }
      if (response.status >= 500 && attempt < this.maxRetries) {
        await this.pacing.sleep(this.pacing.backoffMs(attempt));
        continue;
      }
      throw new MarketplaceError(`Back Market search failed (HTTP ${response.status})`);
    }
    throw new MarketplaceError("giving up on Back Market");
  }
}
