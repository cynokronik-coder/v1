/**
 * Shared extraction: pull product-shaped data out of any search page.
 *
 * This is the part of the Back Market adapter that turned out to be useful for
 * every other site too, so it lives here now and the specialised adapters import
 * it instead of each re-inventing it.
 *
 * Three strategies, in order of trust:
 *
 *   1. JSON-LD (`application/ld+json`, `Product` / `ItemList`) - schema.org, the
 *      one format a site publishes on purpose for machines. When it is there, it
 *      is right.
 *   2. Embedded JSON (`__NEXT_DATA__`, `__NUXT_DATA__`, and any `<script
 *      type="application/json">`) - the site's own payload, walked for objects
 *      that carry both a title and a price.
 *   3. A conservative regex sweep for `"price": 123` style facts next to a title,
 *      used only when there is no structured data at all.
 *
 * What it never does: guess. A page with no recognisable price yields no listings
 * and the caller reports that honestly, which is why every parser here returns
 * `{ items, source }` with `source` naming the strategy that actually worked.
 */

import { makeListing } from "../models.js";

const TITLE_KEYS = ["name", "title", "productName", "label", "model", "subject"];
const PRICE_KEYS = ["price", "minPrice", "amount", "bestPrice", "priceWithTax", "currentPrice", "salePrice", "premiumPrice"];
const URL_KEYS = ["url", "link", "href", "permalink", "slug", "deeplink", "webUrl"];
const IMAGE_KEYS = ["image", "imageUrl", "thumbnail", "picture", "coverImage", "mainImage"];
const CONDITION_KEYS = ["condition", "itemCondition", "state", "conditionLabel", "grade"];
const FAVOURITE_KEYS = ["favourites", "favorites", "favorite_count", "favouriteCount", "likes", "watchers"];

// Nested containers worth descending into before giving up on a payload.
const PRODUCT_CONTAINERS = ["products", "hits", "items", "results", "productList", "offers", "ads", "listings", "edges", "nodes", "data"];

/** "199,90 €" / 199.9 / "199.90" -> 199.9 ; anything else -> null. */
export function toFloat(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "object") {
    // Shopify-style { amount, currencyCode } and Stripe-style { value }.
    return toFloat(value.amount ?? value.value ?? value.price);
  }
  const text = String(value).replace(/\u00a0/g, " ").trim();
  // "1 234,56" and "1,234.56" both land on the same number.
  const cleaned = text.replace(/[^\d.,-]/g, "").replace(/\s/g, "");
  // "sur demande", "gratuit", "—": no digits at all, so there is no number here.
  if (!/\d/.test(cleaned)) return null;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalised = cleaned;
  if (lastComma > lastDot) normalised = cleaned.replace(/\./g, "").replace(",", ".");
  else normalised = cleaned.replace(/,/g, "");
  const parsed = Number(normalised);
  return Number.isNaN(parsed) ? null : parsed;
}

export function titleOf(node) {
  for (const key of TITLE_KEYS) {
    const value = node?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function priceOf(node) {
  for (const key of PRICE_KEYS) {
    const value = toFloat(node?.[key]);
    if (value !== null && value > 0) return value;
  }
  return null;
}

function stringField(node, keys) {
  for (const key of keys) {
    const value = node?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) return value[0].trim();
    if (value && typeof value === "object" && typeof value.url === "string") return value.url;
  }
  return null;
}

function numberField(node, keys) {
  for (const key of keys) {
    const value = toFloat(node?.[key]);
    if (value !== null) return value;
  }
  return null;
}

/** Does this object look like one product with a title and a price? */
export function looksLikeProduct(node) {
  return titleOf(node) !== null && priceOf(node) !== null;
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

/** Embedded app payloads: Next.js, Nuxt, and any plain application/json block. */
export function extractEmbeddedJson(html) {
  const text = String(html || "");
  const payloads = [];
  const patterns = [
    /<script id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
    /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i,
    // window.__INITIAL_STATE__ = {...}; and friends, served inline.
    /window\.__(?:INITIAL_STATE|PRELOADED_STATE|APOLLO_STATE|NUXT|DATA)__\s*=\s*({[\s\S]*?});?\s*<\/script>/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    try {
      payloads.push(JSON.parse(match[1]));
    } catch {
      /* ignore */
    }
  }
  return payloads;
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

function offerCurrency(node) {
  const offers = Array.isArray(node?.offers) ? node.offers[0] : node?.offers;
  return offers?.priceCurrency || node?.priceCurrency || "EUR";
}

/** JSON-LD ItemList / Product graphs -> listings. */
export function listingsFromJsonLd(
  payloads,
  { domain = "", marketplace = "unknown", currency = "EUR" } = {},
) {
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
      const id = node.sku || node.mpn || node.productID || url;
      const title = typeof node.name === "string" ? node.name.trim() : "";
      if (price !== null && price > 0 && title && id && !seen.has(id)) {
        seen.add(id);
        const conditionRaw = [].concat(node.offers?.itemCondition || node.itemCondition || [])[0];
        listings.push(
          makeListing({
            marketplace,
            itemId: String(id),
            title,
            url: absoluteUrl(url, domain),
            price,
            currency: offerCurrency(node) || currency,
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

/** Relative -> absolute against the marketplace domain, so links are clickable. */
export function absoluteUrl(url, domain = "") {
  const text = typeof url === "string" ? url.trim() : "";
  if (!text) return domain ? `https://${domain}/` : "";
  if (/^https?:\/\//i.test(text)) return text;
  if (!domain) return text;
  return `https://${domain.replace(/\/+$/, "")}/${text.replace(/^\/+/, "")}`;
}

/** One product-shaped JSON object -> a listing. */
export function listingFromProduct(node, { marketplace, domain = "", currency = "EUR", condition = null } = {}) {
  const title = titleOf(node);
  const price = priceOf(node);
  if (!title || price === null) return null;
  const rawUrl = stringField(node, URL_KEYS);
  const id =
    node.id ?? node.sku ?? node.itemId ?? node.adId ?? node.listingId ?? node.reference ?? `${title}|${price}`;
  return makeListing({
    marketplace,
    itemId: String(id),
    title,
    url: absoluteUrl(rawUrl, domain),
    price,
    currency: node.currency || node.priceCurrency || currency,
    condition: stringField(node, CONDITION_KEYS) || condition,
    brand: typeof node.brand === "string" ? node.brand : node.brand?.name || null,
    size: typeof node.size === "string" ? node.size : null,
    imageUrl: stringField(node, IMAGE_KEYS),
    description: typeof node.description === "string" ? node.description : null,
    favourites: numberField(node, FAVOURITE_KEYS),
    createdAt: typeof node.createdAt === "string" ? node.createdAt : node.created_at || null,
  });
}

/** The site's own embedded payload -> listings (best-effort walk). */
export function listingsFromEmbeddedJson(payloads, { marketplace, domain = "", currency = "EUR", limit = 200 } = {}) {
  const out = [];
  // A product appearing in two containers (grid + "similar items") is one listing.
  const byId = new Map();
  for (const payload of payloads) {
    for (const node of collectProducts(payload, { limit })) {
      const listing = listingFromProduct(node, { marketplace, domain, currency });
      if (!listing) continue;
      const key = `${listing.title}|${listing.price}`;
      if (!byId.has(key)) byId.set(key, listing);
    }
    if (byId.size) break;
  }
  out.push(...byId.values());
  return out;
}

/**
 * Last resort: no JSON-LD, no embedded payload. Read `price` facts out of the
 * HTML markup itself. Deliberately narrow - a price must sit within a couple of
 * hundred characters of a title-ish attribute - because a wrong price is worse
 * than a missing one.
 */
export function listingsFromMarkup(html, { marketplace, domain = "", currency = "EUR", limit = 60 } = {}) {
  const text = String(html || "");
  const out = [];
  const seen = new Set();

  // <a ... href="/item/123" ...>Title</a> ... 199,90 € (or the reverse order).
  const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{2,200}?)<\/a>([\s\S]{0,400})/gi;
  for (const match of text.matchAll(anchor)) {
    if (out.length >= limit) break;
    const [, href, innerHtml, tail] = match;
    if (!/^\/(?!\/)/.test(href) && !/^https?:/i.test(href)) continue;
    const title = decodeEntities(innerHtml.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (title.length < 4 || title.length > 160) continue;
    // Only look at what belongs to *this* row: stop at the next link, so a grid of
    // cards cannot attach the neighbour's price to this title.
    const next = tail.search(/<a\b/i);
    const scope = next === -1 ? tail : tail.slice(0, next);
    const priceMatch = scope.match(/(\d{1,4}(?:[ .]\d{3})?(?:[.,]\d{1,2})?)\s*(?:€|EUR)/);
    if (!priceMatch) continue;
    const price = toFloat(priceMatch[1]);
    if (price === null || price <= 0) continue;
    const url = absoluteUrl(decodeEntities(href), domain);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(
      makeListing({
        marketplace,
        itemId: url,
        title,
        url,
        price,
        currency,
      }),
    );
  }
  return out;
}

export function decodeEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&eacute;/g, "é")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
}

/**
 * Everything a search page can give us, in order of trust. Returns
 * `{ items, source }` where `source` is `null` when nothing could be read.
 */
export function parseSearchHtml(html, { marketplace, domain = "", currency = "EUR", condition = null } = {}) {
  const context = { marketplace, domain, currency, condition };
  const fromLd = listingsFromJsonLd(extractJsonLd(html), context);
  if (fromLd.length) return { items: fromLd, source: "json-ld" };

  const fromJson = listingsFromEmbeddedJson(extractEmbeddedJson(html), context);
  if (fromJson.length) return { items: fromJson, source: "embedded-json" };

  const fromMarkup = listingsFromMarkup(html, context);
  if (fromMarkup.length) return { items: fromMarkup, source: "markup" };

  return { items: [], source: null };
}

/** Every URL a page references that looks like a listing, for diagnostics. */
export function looksLikeLoginWall(html) {
  const text = String(html || "").slice(0, 20000).toLowerCase();
  return (
    text.includes("connectez-vous") ||
    text.includes("log in to continue") ||
    text.includes("login to continue") ||
    text.includes("you must log in") ||
    text.includes("see more on facebook")
  );
}
