/**
 * eBay's official Browse API: the one large marketplace here with a documented
 * search API, and the preferred resale reference. No network in these tests.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MARKETPLACE_ID,
  EbayAdapter,
  SEARCH_URL,
  TOKEN_URL,
  credentialsMissing,
  missingCredentialsError,
  parseEbayItems,
} from "../src/core/adapters/ebay.js";
import { MarketplaceError, MarketplaceRateLimited } from "../src/core/adapters/base.js";

const noSleep = () => Promise.resolve();

function stub(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const asString = String(url);
    calls.push({ url: asString, init });
    for (const [match, reply] of routes) {
      if (asString.includes(match)) {
        const result = typeof reply === "function" ? reply(asString, init) : reply;
        return { status: result.status ?? 200, body: result.body ?? "", headers: new Headers(result.headers || {}) };
      }
    }
    throw new Error(`unexpected request to ${asString}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const TOKEN_OK = { body: JSON.stringify({ access_token: "token-123", expires_in: 7200 }) };
const SEARCH_OK = {
  body: JSON.stringify({
    total: 812,
    itemSummaries: [
      {
        legacyItemId: "111",
        title: "iPhone 13 256 Go reconditionné",
        itemWebUrl: "https://www.ebay.fr/itm/111",
        price: { value: "329.00", currency: "EUR" },
        condition: "Refurbished",
        brand: "Apple",
        shortDescription: "iPhone 13 256 Go, garanti 12 mois",
        image: { imageUrl: "https://i.ebayimg.com/x.jpg" },
        itemCreationDate: "2026-01-20T10:00:00.000Z",
        shippingOptions: [{ shippingCost: { value: "6.99", currency: "EUR" } }],
      },
      { legacyItemId: "222", title: "no price here" },
    ],
  }),
};

function adapter(fetchImpl, opts = {}) {
  return new EbayAdapter({
    clientId: "app-id",
    clientSecret: "cert-id",
    fetchImpl,
    sleep: noSleep,
    random: () => 0.5,
    maxRetries: 0,
    ...opts,
  });
}

const query = (extra = {}) => ({ searchText: "iphone 13 256", page: 1, perPage: 40, order: "relevance", filters: {}, ...extra });

test("without a keyset it says exactly which keyset and where to get it", async () => {
  const bare = new EbayAdapter({ fetchImpl: stub([]) });
  assert.equal(bare.configured, false);
  assert.equal(credentialsMissing({ clientId: "a", clientSecret: "" }), true);
  await assert.rejects(() => bare.search(query()), (err) => {
    assert.ok(err instanceof MarketplaceError);
    assert.match(err.message, /developer\.ebay\.com\/signin/);
    return true;
  });
  assert.match(missingCredentialsError().message, /Settings/);
});

test("it authenticates with client credentials, then searches with the bearer token", async () => {
  const fetchImpl = stub([[TOKEN_URL, TOKEN_OK], [SEARCH_URL, SEARCH_OK]]);
  const client = adapter(fetchImpl);
  const result = await client.search(query({ minPrice: 100, maxPrice: 500, order: "newest", filters: { conditionIds: ["2500|3000"] } }));

  assert.equal(fetchImpl.calls.length, 2);
  const [tokenCall, searchCall] = fetchImpl.calls;
  assert.equal(tokenCall.init.method, "POST");
  assert.equal(tokenCall.init.headers.Authorization, `Basic ${btoa("app-id:cert-id")}`);
  assert.match(tokenCall.init.body, /grant_type=client_credentials/);
  assert.match(decodeURIComponent(tokenCall.init.body), /oauth\/api_scope/);

  assert.equal(searchCall.init.headers.Authorization, "Bearer token-123");
  assert.equal(searchCall.init.headers["X-EBAY-C-MARKETPLACE-ID"], DEFAULT_MARKETPLACE_ID);
  const params = new URL(searchCall.url).searchParams;
  assert.equal(params.get("q"), "iphone 13 256");
  assert.equal(params.get("limit"), "40");
  assert.equal(params.get("offset"), "0");
  assert.equal(params.get("sort"), "newlyListed");
  assert.match(params.get("filter"), /price:\[100\.\.500\],priceCurrency:EUR/);
  assert.match(params.get("filter"), /conditionIds:2500\|3000/);

  assert.equal(result.totalEntries, 812);
  assert.equal(result.items.length, 1, "an item without a price is not an item");
  assert.equal(result.totalPages, 21);
});

test("the token is reused until it expires", async () => {
  const fetchImpl = stub([[TOKEN_URL, TOKEN_OK], [SEARCH_URL, SEARCH_OK]]);
  const client = adapter(fetchImpl);
  await client.search(query());
  await client.search(query());
  assert.equal(fetchImpl.calls.filter((c) => c.url === TOKEN_URL).length, 1);
  assert.equal(fetchImpl.calls.filter((c) => c.url.startsWith(SEARCH_URL)).length, 2);
  assert.equal(client.requestsMade, 3);
});

test("the payload parser reads what the resale reference needs", () => {
  const [item] = parseEbayItems(JSON.parse(SEARCH_OK.body));
  assert.equal(item.marketplace, "ebay");
  assert.equal(item.itemId, "111");
  assert.equal(item.price, 329);
  assert.equal(item.currency, "EUR");
  assert.equal(item.landedPrice, 335.99, "price plus the stated shipping cost");
  assert.equal(item.condition, "Refurbished");
  assert.equal(item.brand, "Apple");
  assert.equal(item.description, "iPhone 13 256 Go, garanti 12 mois");
  assert.equal(new Date(item.createdAt).toISOString(), "2026-01-20T10:00:00.000Z");
  assert.deepEqual(parseEbayItems({}), []);
});

test("a bad keyset and a rate limit are told apart", async () => {
  const rejected = adapter(stub([[TOKEN_URL, { status: 401, body: "{}" }]]));
  await assert.rejects(() => rejected.search(query()), /rejected the keyset/);

  const throttled = adapter(stub([[TOKEN_URL, TOKEN_OK], [SEARCH_URL, { status: 429, headers: { "Retry-After": "30" } }]]));
  await assert.rejects(() => throttled.search(query()), (err) => {
    assert.ok(err instanceof MarketplaceRateLimited);
    assert.equal(err.retryAfter, 30000);
    return true;
  });

  const broken = adapter(stub([[TOKEN_URL, TOKEN_OK], [SEARCH_URL, { status: 200, body: "<html>nope" }]]));
  await assert.rejects(() => broken.search(query()), /non-JSON/);
});
