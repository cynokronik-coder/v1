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
  parseBuybackQuote,
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

// --- the trade-in quote: the other number on this site ----------------------
//
// A search here returns what a BUYER is charged. What Back Market PAYS is a separate
// flow with its own page, and the two figures are far apart: "up to 385 EUR" on the
// buyback page for a model whose refurbished asks start at 432 EUR.

const BUYBACK_NAMED_FIELD = `<html><body>
<script id="__NUXT_DATA__" type="application/json">{"props":{"buyback":{"maxBuybackPrice":385,"currency":"EUR"}}}</script>
<h1>Vendez votre iPhone 13 Pro Max</h1></body></html>`;

const BUYBACK_FRENCH_TEXT = `<html><body><p>Jusqu'à 385 € pour votre iPhone 13 Pro Max</p><p>Livraison offerte</p></body></html>`;

const BUYBACK_ENGLISH_TEXT = `<html><body><p>Get up to €385 for your iPhone 13 Pro Max</p></body></html>`;

const ASKING_PRICE_PAGE = `<html><head>
<script type="application/ld+json">{"@type":"Product","name":"iPhone 13 Pro Max reconditionné","offers":{"price":"432","priceCurrency":"EUR"}}</script>
</head><body><p>432,00 €</p><p>Prix neuf conseillé 1 159 €</p></body></html>`;

test("a trade-in quote is read from a named field when the page carries one", () => {
  const quote = parseBuybackQuote(BUYBACK_NAMED_FIELD, { url: "https://example.invalid/buyback" });
  assert.equal(quote.amount, 385);
  assert.equal(quote.currency, "EUR");
  assert.equal(quote.readFrom, "named field");
  assert.equal(quote.url, "https://example.invalid/buyback");
});

test("otherwise the headline is read, in French or in English", () => {
  assert.equal(parseBuybackQuote(BUYBACK_FRENCH_TEXT).amount, 385);
  assert.equal(parseBuybackQuote(BUYBACK_FRENCH_TEXT).readFrom, "page text");
  assert.equal(parseBuybackQuote(BUYBACK_ENGLISH_TEXT).amount, 385);
  // Thousands separators and a decimal comma are normal on this site.
  assert.equal(parseBuybackQuote("<p>Jusqu'à 1 385,50 €</p>").amount, 1385.5);
});

test("an asking price is never mistaken for a payout: no quote framing, no number", () => {
  // The whole point of this path. A generic price on a buyback-shaped page - or a
  // refurbished ask in JSON-LD - must come back as no quote at all, not as a payout.
  assert.equal(parseBuybackQuote(ASKING_PRICE_PAGE), null);
  assert.equal(parseBuybackQuote(NUXT_PAGE), null, "the search page's own payload has no quote in it");
  assert.equal(parseBuybackQuote(""), null);
  assert.equal(parseBuybackQuote("<p>Jusqu'à 0 €</p>"), null, "zero is not a quote");
});

test("the quote request goes to the model's buyback page and reports where it looked", async () => {
  const fetchImpl = stub(BUYBACK_NAMED_FIELD);
  const client = adapter(fetchImpl);
  const result = await client.quote({ product: { category: "phones", name: "iPhone 13 Pro Max" }, keyword: "iphone 13 pro max" });

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, "https://www.backmarket.fr/fr-fr/buyback/m/smartphone/iphone-13-pro-max");
  assert.equal(result.exact, true);
  assert.equal(result.quote.amount, 385);
  assert.equal(result.reason, null);
  assert.equal(client.requestsMade, 1, "the request is counted, like a search's is");
});

test("a category whose model URL is unverified is sent to the flow's home page, not a guessed path", async () => {
  const fetchImpl = stub(BUYBACK_FRENCH_TEXT);
  const client = adapter(fetchImpl);
  const result = await client.quote({ product: { category: "consoles", name: "PlayStation 5" } });
  assert.equal(fetchImpl.calls[0].url, "https://www.backmarket.fr/fr-fr/buyback/home");
  assert.equal(result.exact, false);
  assert.equal(result.quote.amount, 385);
});

test("an unreadable quote is a stated gap with the link, and never a thrown run", async () => {
  const refused = adapter(stub(JSON.stringify({ url: "https://geo.captcha-delivery.com/x" }), { status: 403 }));
  const blocked = await refused.quote({ product: { category: "phones", name: "iPhone 13" } });
  assert.equal(blocked.quote, null);
  assert.match(blocked.reason, /HTTP 403/);
  assert.match(blocked.reason, /open www\.backmarket\.fr in a tab/);
  assert.equal(blocked.url, "https://www.backmarket.fr/fr-fr/buyback/m/smartphone/iphone-13");

  // A page with no quote in it: the model may not be in the buyback catalogue at all.
  const empty = await adapter(stub("<html><body>rien</body></html>")).quote({ product: { category: "phones", name: "iPhone 13" } });
  assert.equal(empty.quote, null);
  assert.match(empty.reason, /no quote could be read/);
  assert.match(empty.reason, /may not be in the buyback catalogue/);

  // A search that fails loudly is a lost product; a quote that fails quietly is not.
  const broken = await adapter({
    async fetch() {
      throw new Error("network down");
    },
  }).quote({ product: { category: "phones", name: "iPhone 13" } });
  assert.equal(broken.quote, null);
  assert.match(broken.reason, /could not be fetched/);
});
