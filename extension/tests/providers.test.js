/**
 * The data providers: the "connect a tool instead of scraping it myself" path.
 *
 * Every call here is tested with an injected fetch, so what is asserted is the
 * request the extension actually makes (endpoint, auth, body) and the listing shape
 * it produces. No network, no keys, no billing.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  KEEPA_DOMAIN,
  ProviderError,
  apifyListings,
  brightDataPage,
  configuredProviders,
  createApifyAdapter,
  keepaPrice,
  mapProviderItems,
  serpApiShopping,
  serpApiTrends,
} from "../src/core/providers.js";

const json = (payload, status = 200) => ({ status, body: JSON.stringify(payload), headers: new Headers() });
const failing = (status, body = "") => ({ status, body, headers: new Headers() });

function spy(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("a provider without its key refuses, and says where to get one", async () => {
  await assert.rejects(
    () => apifyListings({ settings: {}, fetchImpl: spy(() => json([])), marketplace: "vinted", actor: "a~b", query: "x" }),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.match(err.message, /Apify needs an API key/);
      assert.match(err.message, /Settings -> Data providers/);
      assert.match(err.message, /docs\.apify\.com/);
      return true;
    },
  );
  await assert.rejects(
    () => serpApiShopping({ settings: {}, fetchImpl: spy(() => json({})), query: "x" }),
    /SerpApi needs an API key/,
  );
  await assert.rejects(
    () => keepaPrice({ settings: {}, fetchImpl: spy(() => json({})), asin: "B0" }),
    /Keepa .*needs an API key/,
  );
  await assert.rejects(
    () => brightDataPage({ settings: {}, fetchImpl: spy(() => json({})), marketplace: "vinted", url: "https://x" }),
    /Bright Data needs an API key/,
  );
});

test("Apify runs the actor synchronously and normalises its dataset", async () => {
  const fetchImpl = spy((url, init) => {
    // The canonical path (the older /v2/acts/ form still works but is deprecated),
    // and the token in a header rather than the query string.
    assert.match(url, /^https:\/\/api\.apify\.com\/v2\/actors\/user~vinted-scraper\/run-sync-get-dataset-items\?/);
    assert.match(url, /limit=25/);
    assert.equal(init.headers.Authorization, "Bearer secret-token");
    assert.ok(!url.includes("secret-token"), "a token must not travel in the query string");
    return json([
      { id: 1, title: "iPhone 13 128 Go", price: "249,00", url: "https://www.vinted.fr/items/1", currency: "EUR", favouriteCount: 12 },
      { id: 2, title: "no price" },
    ]);
  });
  const result = await apifyListings({
    settings: { apifyToken: "secret-token" },
    fetchImpl,
    marketplace: "vinted",
    actor: "user/vinted-scraper",
    query: "iphone 13",
    maxItems: 25,
  });

  assert.equal(fetchImpl.calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), {
    search: "iphone 13",
    keyword: "iphone 13",
    query: "iphone 13",
    maxItems: 25,
    country: "FR",
    currency: "EUR",
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].price, 249);
  assert.equal(result.items[0].marketplace, "vinted");
  assert.equal(result.items[0].favourites, 12);
});

test("Apify without an actor configured explains what is missing", async () => {
  await assert.rejects(
    () => apifyListings({ settings: { apifyToken: "t" }, fetchImpl: spy(() => json([])), marketplace: "vinted", query: "x" }),
    /no actor is configured for vinted/,
  );
});

test("mapProviderItems tolerates the shapes vendors actually return", () => {
  assert.equal(mapProviderItems([{ title: "A", price: 10 }], { marketplace: "vinted" }).length, 1);
  assert.equal(mapProviderItems({ items: [{ name: "B", amount: 20 }] }, { marketplace: "vinted" }).length, 1);
  assert.equal(mapProviderItems({ data: [{ subject: "C", priceEur: 30 }] }, { marketplace: "vinted" }).length, 1);
  assert.equal(mapProviderItems([{ title: "no price" }, { price: 5 }, "junk"], { marketplace: "vinted" }).length, 0);
  assert.equal(mapProviderItems(null, { marketplace: "vinted" }).length, 0);
  const [listing] = mapProviderItems([{ itemId: "x", title: "D", price: "1 200,50 €", link: "https://x.test/d" }], {
    marketplace: "leboncoin",
  });
  assert.equal(listing.price, 1200.5);
  assert.equal(listing.url, "https://x.test/d");
});

test("SerpApi Google Shopping becomes a resale reference, not a marketplace", async () => {
  const fetchImpl = spy((url) => {
    assert.match(url, /^https:\/\/serpapi\.com\/search\.json\?/);
    assert.match(url, /engine=google_shopping/);
    assert.match(url, /q=iphone%2013/);
    assert.match(url, /gl=fr/);
    assert.match(url, /api_key=key-1/);
    return json({
      shopping_results: [
        { position: 1, title: "iPhone 13 reconditionné 128 Go", extracted_price: 279, product_link: "https://shop.test/p1", source: "Shop" },
        { position: 2, title: "No price here" },
      ],
    });
  });
  const result = await serpApiShopping({ settings: { serpApiKey: "key-1" }, fetchImpl, query: "iphone 13" });
  assert.equal(result.marketplace, "google-shopping");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].price, 279);
  assert.equal(result.provider, "serpapi");
});

test("the Google Trends request uses a window Google Trends actually accepts", async () => {
  const fetchImpl = spy((url) => {
    // "today 3-m", not "today 90-d": Google Trends has no day-count window form.
    assert.match(url, /engine=google_trends/);
    assert.match(url, /date=today%203-m/);
    assert.match(url, /geo=FR/);
    assert.match(url, /data_type=TIMESERIES/);
    return json({ interest_over_time: { timeline_data: [{ values: [{ extracted_value: 50 }] }] } });
  });
  const result = await serpApiTrends({ settings: { serpApiKey: "k" }, fetchImpl, query: "iphone 13" });
  assert.equal(result.points, 1);
});

test("SerpApi Google Trends reports direction, which is what a demand signal needs", async () => {
  const timeline = (values) => ({ interest_over_time: { timeline_data: values.map((value) => ({ values: [{ extracted_value: value }] })) } });
  const rising = await serpApiTrends({
    settings: { serpApiKey: "k" },
    fetchImpl: spy(() => json(timeline([20, 20, 20, 40, 45, 50, 60, 70, 80]))),
    query: "iphone 13",
  });
  assert.equal(rising.direction, "rising");
  assert.equal(rising.score, 0.7, "the score is the average of the last third, over 100");
  assert.match(rising.reasons[0], /Google Trends interest rising/);

  const falling = await serpApiTrends({
    settings: { serpApiKey: "k" },
    fetchImpl: spy(() => json(timeline([80, 80, 80, 40, 30, 20, 10, 10, 10]))),
    query: "iphone 13",
  });
  assert.equal(falling.direction, "falling");

  const flat = await serpApiTrends({
    settings: { serpApiKey: "k" },
    fetchImpl: spy(() => json(timeline([50, 50, 50, 50, 50, 50]))),
    query: "x",
  });
  assert.equal(flat.direction, "flat");

  await assert.rejects(
    () => serpApiTrends({ settings: { serpApiKey: "k" }, fetchImpl: spy(() => json({})), query: "x" }),
    /no trend points/,
  );
});

test("Bright Data fetches a page and the same extractor reads it", async () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Sony A7 III",
    url: "https://www.leboncoin.fr/ad/1",
    sku: "1",
    offers: { "@type": "Offer", price: "900", priceCurrency: "EUR" },
  })}</script></head></html>`;
  const fetchImpl = spy((url, init) => {
    assert.equal(url, "https://api.brightdata.com/request");
    assert.equal(init.headers.Authorization, "Bearer bd-token");
    assert.deepEqual(JSON.parse(init.body), { zone: "unlocker", url: "https://www.leboncoin.fr/recherche?text=a7", format: "raw" });
    return { status: 200, body: html, headers: new Headers() };
  });
  const result = await brightDataPage({
    settings: { brightDataToken: "bd-token", brightDataZone: "unlocker" },
    fetchImpl,
    marketplace: "leboncoin",
    url: "https://www.leboncoin.fr/recherche?text=a7",
    domain: "www.leboncoin.fr",
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].price, 900);
  assert.equal(result.strategy, "json-ld");
});

test("Bright Data without a zone says exactly which field is missing", async () => {
  await assert.rejects(
    () => brightDataPage({ settings: { brightDataToken: "t" }, fetchImpl: spy(() => json({})), marketplace: "vinted", url: "https://x" }),
    /needs a zone name/,
  );
});

test("Keepa converts cents into a price and reports the 30-day average", async () => {
  const fetchImpl = spy((url) => {
    assert.match(url, /^https:\/\/api\.keepa\.com\/product\?/);
    assert.match(url, /domain=4/);
    assert.match(url, /asin=B08N5WRWNW/);
    return json({
      products: [
        {
          title: "Apple iPhone 13 128GB",
          stats: { current: [27990, 26000], avg30: [29990, 28000] },
          csv: [1, 2, 3, 4, 5, 6],
        },
      ],
    });
  });
  const result = await keepaPrice({ settings: { keepaKey: "kk" }, fetchImpl, asin: "B08N5WRWNW", domain: KEEPA_DOMAIN.fr });
  assert.equal(result.price, 279.9);
  assert.equal(result.median30d, 299.9);
  assert.equal(result.historyPoints, 6);
  assert.match(result.reasons[0], /Keepa: Amazon asking price 279\.90/);
  assert.match(result.reasons[0], /30-day average 299\.90/);

  // "-1" is Keepa's way of saying there is no price, never a price of -0.01.
  const noCurrent = await keepaPrice({
    settings: { keepaKey: "kk" },
    fetchImpl: spy(() => json({ products: [{ title: "x", stats: { current: [-1], avg30: [25000] }, csv: [] }] })),
    asin: "B0X",
  });
  assert.equal(noCurrent.price, 250);
  assert.match(noCurrent.reasons[0], /no current price, using the 30-day average/);

  await assert.rejects(
    () =>
      keepaPrice({
        settings: { keepaKey: "kk" },
        fetchImpl: spy(() => json({ products: [{ title: "x", stats: { current: [-1], avg30: [-1] }, csv: [] }] })),
        asin: "B0Y",
      }),
    /no price history for B0Y/,
  );

  await assert.rejects(
    () => keepaPrice({ settings: { keepaKey: "kk" }, fetchImpl: spy(() => json({ products: [] })), asin: "NOPE" }),
    /knows no product with ASIN NOPE/,
  );
});

test("the Apify fallback adapter is adapter-shaped: configured, search, honest result", async () => {
  const fetchImpl = spy(() => json([{ id: "1", title: "Nintendo Switch OLED", price: 210, url: "https://x.test/1" }]));
  const settings = { apifyToken: "t", sources: { momox: { actor: "user~momox" } } };
  const adapter = createApifyAdapter({ settings, fetchImpl, marketplace: "momox" });
  assert.equal(adapter.configured, true);

  const result = await adapter.search({ searchText: "nintendo switch", perPage: 5 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].marketplace, "momox");
  assert.equal(result.totalEntries, null, "a vendor list is not a market total");
  assert.equal(adapter.requestsMade, 1);

  const unconfigured = createApifyAdapter({ settings: { sources: {} }, fetchImpl, marketplace: "momox" });
  assert.equal(unconfigured.configured, false);
});

test("a vendor error is a ProviderError with the status and a snippet, not a crash", async () => {
  await assert.rejects(
    () => apifyListings({ settings: { apifyToken: "t" }, fetchImpl: spy(() => failing(401, "unauthorized")), marketplace: "vinted", actor: "a~b", query: "x" }),
    /Apify actor a~b failed \(HTTP 401\): unauthorized/,
  );
  await assert.rejects(
    () => apifyListings({ settings: { apifyToken: "t" }, fetchImpl: spy(() => ({ status: 200, body: "not json", headers: new Headers() })), marketplace: "vinted", actor: "a~b", query: "x" }),
    /returned non-JSON content/,
  );
});

test("configuredProviders lists exactly the providers whose keys are present", () => {
  assert.deepEqual(configuredProviders({}), []);
  assert.deepEqual(configuredProviders({ apifyToken: "a", serpApiKey: "b" }), ["apify", "serpapi"]);
  // Bright Data needs both its token and its zone.
  assert.deepEqual(configuredProviders({ brightDataToken: "a" }), []);
  assert.deepEqual(configuredProviders({ brightDataToken: "a", brightDataZone: "z", keepaKey: "k" }), ["brightdata", "keepa"]);
});
