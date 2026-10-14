/**
 * Back Market: a resale reference with no public search API, so this adapter reads
 * what the page embeds - and must fail *loudly* rather than invent a price. These
 * tests pin both halves: what it can read, and how it refuses.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BackMarketAdapter,
  collectProducts,
  extractEmbeddedJson,
  extractJsonLd,
  listingsFromJsonLd,
  parseBackMarketHtml,
} from "../src/core/adapters/backmarket.js";
import { MarketplaceBlocked, MarketplaceError } from "../src/core/adapters/base.js";

const noSleep = () => Promise.resolve();

const LD_PAGE = `<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"ItemList","itemListElement":[
  {"@type":"ListItem","item":{"@type":"Product","name":"iPhone 13 128 Go reconditionné","sku":"BM-13-128",
   "url":"https://www.backmarket.fr/fr-fr/p/iphone-13/abc","brand":{"@type":"Brand","name":"Apple"},
   "image":["https://cdn.backmarket.fr/x.jpg"],
   "offers":{"@type":"Offer","price":"299.99","priceCurrency":"EUR","itemCondition":"http://schema.org/RefurbishedCondition"}}},
  {"@type":"ListItem","item":{"@type":"Product","name":"iPhone 13 256 Go reconditionné","sku":"BM-13-256",
   "url":"https://www.backmarket.fr/fr-fr/p/iphone-13/def",
   "offers":{"price":"349.99","priceCurrency":"EUR"}}}
]}</script>
</head><body>nothing else</body></html>`;

const NUXT_PAGE = `<html><body>
<script id="__NUXT_DATA__" type="application/json">
{"data":{"products":[{"id":"p1","name":"iPhone 13 256 Go","price":339.99,"currency":"EUR","slug":"/fr-fr/p/iphone-13/xyz"},
{"id":"p2","name":"Coque iPhone 13","price":9.99,"slug":"/fr-fr/p/coque"}]}}
</script></body></html>`;

function stub(body, { status = 200, headers = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return { status, body, headers: new Headers(headers) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function adapter(fetchImpl, opts = {}) {
  return new BackMarketAdapter({ fetchImpl, sleep: noSleep, random: () => 0.5, maxRetries: 0, ...opts });
}

const query = { searchText: "iphone 13 256", page: 1, perPage: 40, order: "relevance", filters: {} };

test("JSON-LD is the preferred source, and it round-trips condition and currency", () => {
  const { items, source } = parseBackMarketHtml(LD_PAGE);
  assert.equal(source, "json-ld");
  assert.equal(items.length, 2);
  assert.equal(items[0].price, 299.99);
  assert.equal(items[0].currency, "EUR");
  assert.equal(items[0].condition, "reconditionné");
  assert.equal(items[0].brand, "Apple");
  assert.equal(items[0].itemId, "BM-13-128");
  assert.equal(items[1].url, "https://www.backmarket.fr/fr-fr/p/iphone-13/def");
  assert.equal(extractJsonLd(LD_PAGE).length, 1);
  assert.deepEqual(listingsFromJsonLd(extractJsonLd("<html>no ld</html>")).length, 0);
});

test("when there is no JSON-LD, the page's own embedded payload is read instead", () => {
  const { items, source } = parseBackMarketHtml(NUXT_PAGE);
  assert.equal(source, "embedded-json");
  assert.deepEqual(items.map((item) => item.title), ["iPhone 13 256 Go", "Coque iPhone 13"]);
  assert.equal(items[0].url, "https://www.backmarket.fr/fr-fr/p/iphone-13/xyz");
  assert.equal(items[0].price, 339.99);
  assert.equal(extractEmbeddedJson(NUXT_PAGE).length, 1);
});

test("the walker only keeps objects that look like a product, at any depth", () => {
  const payload = {
    hits: { nested: { list: [{ name: "Real product", price: 120 }, { name: "no price" }, { price: 12 }] } },
    unrelated: { some: { count: 3, label: "not a product" } },
  };
  const found = collectProducts(payload);
  assert.deepEqual(found.map((item) => item.name), ["Real product"]);
  assert.deepEqual(collectProducts(null), []);
});

test("a search returns listings and records which transport and source answered", async () => {
  const fetchImpl = stub(LD_PAGE);
  const client = adapter(fetchImpl);
  const result = await client.search(query);
  assert.equal(result.items.length, 2);
  assert.equal(result.source, "json-ld");
  assert.equal(result.totalEntries, 2);
  assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get("q"), "iphone 13 256");
  assert.equal(client.requestsMade, 1);
  assert.equal(client.lastSource, "json-ld");
});

test("it prefers your own open Back Market tab when there is one", async () => {
  const workerFetch = stub("<html></html>");
  const tabCalls = [];
  const tabTransport = {
    async available() {
      return true;
    },
    async fetchInTab(url, init) {
      tabCalls.push({ url, init });
      return { status: 200, body: LD_PAGE, headers: new Headers() };
    },
  };
  const client = new BackMarketAdapter({ fetchImpl: workerFetch, tabTransport, sleep: noSleep, random: () => 0.5 });
  const result = await client.search(query);
  assert.equal(result.items.length, 2);
  assert.equal(tabCalls.length, 1);
  assert.equal(workerFetch.calls.length, 0, "the worker must not also hit the site");
});

test("readable page but no product data is an error, never a guess", async () => {
  const client = adapter(stub("<html><body>Nothing useful here</body></html>"));
  await assert.rejects(() => client.search(query), (err) => {
    assert.ok(err instanceof MarketplaceError);
    assert.match(err.message, /no product data could be read/);
    assert.match(err.message, /manual resale price/);
    return true;
  });
});

test("a bot-protection refusal says so and points at the tab, or a manual price", async () => {
  const client = adapter(stub(JSON.stringify({ url: "https://geo.captcha-delivery.com/x" }), { status: 403 }));
  await assert.rejects(() => client.search(query), (err) => {
    assert.ok(err instanceof MarketplaceBlocked);
    assert.match(err.message, /Open backmarket\.fr in a normal tab/);
    assert.match(err.message, /manual resale price/);
    return true;
  });
});

test("an HTTP error is reported as an HTTP error", async () => {
  const client = adapter(stub("", { status: 500 }));
  await assert.rejects(() => client.search(query), /HTTP 500/);
});
