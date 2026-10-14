/**
 * Deterministic offline marketplace.
 *
 * Used by the node tests, by the dashboard's "self-check", and by any watch with
 * `marketplace: mock` - so the whole pipeline can be exercised with no network, no
 * account and no terms-of-use question. It plants genuine bargains around a base
 * price and junk listings below the plausibility floor, so the analyzer's filters
 * are exercised rather than bypassed.
 *
 * The generator is a small seeded PRNG (mulberry32), not Python's Mersenne
 * Twister, so its numbers are stable per search text but not identical to the
 * Python mock. Only the shape matters here.
 */

import { makeListing } from "../models.js";
import { ORDER } from "./base.js";

export const JUNK_PRICE = 1.0;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class MockAdapter {
  name = "mock";

  constructor({
    market = null,
    basePrice = 200,
    spread = 0.35,
    poolSize = 60,
    bargainDiscounts = [0.45, 0.4, 0.35],
    junkListings = 2,
    currency = "EUR",
    seed = 7,
  } = {}) {
    this.market = market || {};
    this.basePrice = basePrice;
    this.spread = spread;
    this.poolSize = poolSize;
    this.bargainDiscounts = bargainDiscounts;
    this.junkListings = junkListings;
    this.currency = currency;
    this.seed = seed;
    this.requestsMade = 0;
  }

  generate(searchText) {
    const rng = mulberry32((hashString(searchText) ^ Math.imul(this.seed, 2654435761)) >>> 0);
    const prefix = hashString(searchText) % 1000000;
    const listings = [];
    for (let i = 0; i < this.poolSize; i += 1) {
      const price = Math.round(this.basePrice * (1 + (rng() * 2 - 1) * this.spread) * 100) / 100;
      listings.push(this._listing(searchText, prefix, `std-${i}`, price, i));
    }
    this.bargainDiscounts.forEach((discount, n) => {
      const price = Math.round(this.basePrice * (1 - discount) * 100) / 100;
      listings.push(this._listing(searchText, prefix, `deal-${n}`, price, 1000 + n));
    });
    for (let n = 0; n < this.junkListings; n += 1) {
      listings.push(this._listing(searchText, prefix, `junk-${n}`, JUNK_PRICE, 2000 + n));
    }
    return listings;
  }

  _listing(searchText, prefix, slug, price, index) {
    const itemId = `${prefix}-${slug}`;
    return makeListing({
      marketplace: this.name,
      itemId,
      title: `${searchText} - listing ${index}`,
      url: `https://example.invalid/items/${itemId}`,
      price,
      currency: this.currency,
      landedPrice: Math.round((price * 1.05 + 1) * 100) / 100,
      condition: "très bon état",
      brand: searchText.split(/\s+/)[0],
      size: "M",
      // A description, so the offline demo exercises the exact-phrase filter too.
      description: `${searchText} - detailed description for listing ${index}`,
      imageUrl: null,
      favourites: index % 7,
    });
  }

  async search(query) {
    if (!query.page || query.page < 1) throw new Error("page must be >= 1");
    this.requestsMade += 1;
    let pool = this.market[query.searchText] || this.generate(query.searchText);
    if (query.order === ORDER.PRICE_ASC) pool = [...pool].sort((a, b) => a.price - b.price);
    else if (query.order === ORDER.PRICE_DESC) pool = [...pool].sort((a, b) => b.price - a.price);
    else if (query.order === ORDER.NEWEST) pool = [...pool].reverse();

    const perPage = query.perPage || 96;
    const start = (query.page - 1) * perPage;
    return {
      marketplace: this.name,
      items: pool.slice(start, start + perPage),
      page: query.page,
      perPage,
      totalEntries: pool.length,
      totalPages: Math.max(1, Math.ceil(pool.length / perPage)),
    };
  }
}
