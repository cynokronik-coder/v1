/**
 * Adapter behaviour against a stubbed transport: no network in the test suite.
 * The request shapes asserted here are the ones verified against the live Vinted
 * API and the live leboncoin endpoints by the Python tool.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MarketplaceBlocked,
  MarketplaceError,
  MarketplaceRateLimited,
  looksLikeChallenge,
  retryAfterMs,
} from "../src/core/adapters/base.js";
import { LeboncoinAdapter, findAdsInPage } from "../src/core/adapters/leboncoin.js";
import { MockAdapter } from "../src/core/adapters/mock.js";
import { VintedAdapter } from "../src/core/adapters/vinted.js";
import { getAdapter } from "../src/core/adapters/index.js";

const noSleep = () => Promise.resolve();
const noJitter = () => 0.5;

/** A fetch stub returning the minimal response shape the adapters consume. */
function stub(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const asString = String(url);
    calls.push({ url: asString, init });
    for (const [match, reply] of routes) {
      const hit = typeof match === "string" ? asString.includes(match) : match.test(asString);
      if (hit) {
        const result = typeof reply === "function" ? reply(asString, init, calls) : reply;
        return {
          status: result.status ?? 200,
          body: result.body ?? "",
          headers: new Headers(result.headers || {}),
        };
      }
    }
    throw new Error(`unexpected request to ${asString}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const cookieJar = (values) => async (_url, name) => values[name] ?? null;

const DATADOME_403 = {
  status: 403,
  body: JSON.stringify({ url: "https://geo.captcha-delivery.com/captcha/?cid=x", message: "blocked" }),
};

const VINTED_EMPTY = {
  body: JSON.stringify({ items: [], pagination: { current_page: 1, per_page: 24, total_entries: 0, total_pages: 0 } }),
};

function vinted(handler, opts = {}) {
  return new VintedAdapter({
    fetchImpl: typeof handler === "function" ? handler : stub(handler),
    cookies: cookieJar({ anon_id: "abc-123" }),
    sleep: noSleep,
    random: noJitter,
    maxRetries: 1,
    ...opts,
  });
}

test("vinted bootstraps a session and sends the anon id", async () => {
  const fetchImpl = stub([
    ["www.vinted.fr/", { body: "<html></html>" }],
    ["api.vinted.fr", VINTED_EMPTY],
  ]);
  const adapter = vinted(fetchImpl);
  const result = await adapter.search({
    searchText: "nike air max 90", page: 1, perPage: 24, order: "newest",
    filters: {}, minPrice: null, maxPrice: null,
  });

  assert.equal(result.totalEntries, 0);
  assert.equal(fetchImpl.calls[0].url, "https://www.vinted.fr/");
  const apiCall = fetchImpl.calls[1];
  assert.ok(apiCall.url.startsWith("https://api.vinted.fr/svc-catalogue/items?"));
  assert.equal(apiCall.init.headers["X-Anon-Id"], "abc-123");
  const params = new URL(apiCall.url).searchParams;
  assert.equal(params.get("search_text"), "nike air max 90");
  assert.equal(params.get("order"), "newest_first"); // translated for the API
  assert.equal(params.get("per_page"), "24");
  // Cookies ride along because the browser owns them, never as a header we set.
  assert.equal(apiCall.init.credentials, "include");
  assert.ok(!apiCall.init.headers.Cookie);
  assert.ok(!apiCall.init.headers["User-Agent"], "a browser refuses to set User-Agent");
});

test("vinted builds price bounds, filters and currency", async () => {
  const fetchImpl = stub([
    ["www.vinted.fr/", { body: "" }],
    ["api.vinted.fr", VINTED_EMPTY],
  ]);
  await vinted(fetchImpl).search({
    searchText: "iphone 13", page: 2, perPage: 24, order: "price_asc", currency: "EUR",
    filters: { brand: ["53", "417"], catalog: ["2996"] }, minPrice: 100, maxPrice: 400,
  });
  const params = new URL(fetchImpl.calls.at(-1).url).searchParams;
  assert.equal(params.get("price_from"), "100");
  assert.equal(params.get("price_to"), "400");
  assert.equal(params.get("currency"), "EUR");
  assert.equal(params.get("order"), "price_low_to_high");
  assert.equal(params.get("page"), "2");
  assert.equal(params.get("attribute_ids[brand]"), "53,417");
  assert.equal(params.get("attribute_ids[catalog]"), "2996");
});

test("vinted refreshes a refused session once, then stops", async () => {
  const fetchImpl = stub([
    ["www.vinted.fr/", { body: "" }],
    ["api.vinted.fr", { status: 403, body: JSON.stringify({ code: "FORBIDDEN" }) }],
  ]);
  const adapter = vinted(fetchImpl);
  await assert.rejects(
    () => adapter.search({ searchText: "nike", page: 1, perPage: 24, order: "relevance", filters: {} }),
    (err) => {
      assert.ok(err instanceof MarketplaceBlocked);
      assert.match(err.message, /refused/);
      assert.match(err.message, /CAPTCHAs/);
      return true;
    },
  );
  const hosts = fetchImpl.calls.map((c) => new URL(c.url).host);
  assert.deepEqual(hosts, ["www.vinted.fr", "api.vinted.fr", "www.vinted.fr", "api.vinted.fr"]);
});

test("vinted honours Retry-After, then reports a rate limit", async () => {
  const fetchImpl = stub([
    ["www.vinted.fr/", { body: "" }],
    ["api.vinted.fr", { status: 429, headers: { "Retry-After": "0" } }],
  ]);
  await assert.rejects(
    () => vinted(fetchImpl).search({ searchText: "nike", page: 1, perPage: 24, filters: {} }),
    (err) => err instanceof MarketplaceRateLimited,
  );
});

test("vinted reports a 200 that is not JSON as a challenge", async () => {
  const fetchImpl = stub([
    ["www.vinted.fr/", { body: "" }],
    ["api.vinted.fr", { body: "<html>please verify you are human</html>" }],
  ]);
  await assert.rejects(
    () => vinted(fetchImpl).search({ searchText: "nike", page: 1, perPage: 24, filters: {} }),
    (err) => err instanceof MarketplaceError && /challenge/.test(err.message),
  );
});

function leboncoin(routes, opts = {}) {
  return new LeboncoinAdapter({
    fetchImpl: stub(routes),
    cookies: cookieJar({ datadome: "cookie-value" }),
    sleep: noSleep,
    random: noJitter,
    maxRetries: 1,
    ...opts,
  });
}

const LBC_API_OK = { body: JSON.stringify({ ads: [{ list_id: 1, subject: "velo", price_cents: 15000 }], total: 70 }) };
const SEARCH_HTML = {
  body: '<html><script id="__NEXT_DATA__" type="application/json">' +
    '{"props":{"pageProps":{"searchData":{"ads":[{"list_id":42,"subject":"velo course","price_cents":15000,' +
    '"attributes":[{"key":"condition","value":"etatbon","value_label":"Bon état"}]}],"total":1}}}}</script></html>',
};

function query(extra = {}) {
  return { searchText: "iphone 13", page: 1, perPage: 96, order: "relevance", filters: {}, ...extra };
}

test("leboncoin prices in the api filter are cents, and the page url uses euros", () => {
  const adapter = leboncoin([["api.leboncoin.fr", LBC_API_OK]]);
  const body = adapter.buildBody(query({ minPrice: 100, maxPrice: 400, filters: { category: ["2978"], owner_type: ["private"] } }));
  assert.deepEqual(body.filters.ranges.price, { min: 10000, max: 40000 });
  assert.equal(body.limit, 35); // clamped: leboncoin ignores larger limits
  assert.deepEqual(body.filters.enums, { ad_type: ["offer"], owner_type: ["private"] });
  assert.deepEqual(body.filters.category, { id: "2978" });
  assert.equal(body.offset, 0);
  assert.equal(adapter.buildBody(query({ page: 3 })).offset, 70);

  const url = adapter.searchUrl(query({ minPrice: 100, maxPrice: 400, order: "newest" }));
  const params = new URL(url).searchParams;
  assert.equal(params.get("text"), "iphone 13");
  assert.equal(params.get("price"), "100-400"); // euros here, not cents
  assert.equal(params.get("limit"), "35");
  assert.equal(params.get("sort"), "time");
  assert.equal(params.get("order"), "desc");
});

test("leboncoin translates order, category and location", () => {
  const adapter = leboncoin([["api.leboncoin.fr", LBC_API_OK]]);
  const body = adapter.buildBody(
    query({ order: "newest", filters: { category: ["55"], regions: ["12"] } }),
  );
  assert.equal(body.sort_by, "time");
  assert.equal(body.sort_order, "desc");
  assert.deepEqual(body.filters.location, { regions: ["12"] });
});

test("leboncoin falls back from the api to the search page", async () => {
  const fetchImpl = stub([
    ["api.leboncoin.fr", DATADOME_403],
    ["/recherche?", SEARCH_HTML],
  ]);
  const adapter = new LeboncoinAdapter({
    fetchImpl, cookies: cookieJar({ datadome: "c" }), sleep: noSleep, random: noJitter, maxRetries: 0,
  });
  const result = await adapter.search(query());
  assert.deepEqual(fetchImpl.calls.map((c) => new URL(c.url).host), ["api.leboncoin.fr", "www.leboncoin.fr"]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].price, 150.0);
  assert.equal(result.items[0].condition, "Bon état");
});

test("leboncoin reports a DataDome block with actionable advice and does not retry", async () => {
  const fetchImpl = stub([
    ["api.leboncoin.fr", DATADOME_403],
    ["/recherche?", DATADOME_403],
  ]);
  const adapter = new LeboncoinAdapter({
    fetchImpl, cookies: cookieJar({}), sleep: noSleep, random: noJitter, maxRetries: 1,
  });
  await assert.rejects(
    () => adapter.search(query()),
    (err) => {
      assert.ok(err instanceof MarketplaceBlocked);
      assert.match(err.message, /DataDome/);
      assert.match(err.message, /Open leboncoin\.fr/); // the advice for a shared session
      assert.match(err.message, /CAPTCHAs/);
      return true;
    },
  );
  // one attempt per transport: a challenge is never retried
  assert.equal(fetchImpl.calls.length, 2);
});

test("leboncoin drops wanted ads, sold listings and other seller types", async () => {
  const ads = {
    body: JSON.stringify({
      ads: [
        { list_id: 1, subject: "offre", price_cents: 100, ad_type: "offer", status: "active" },
        { list_id: 2, subject: "demande", price_cents: 100, ad_type: "demand", status: "active" },
        { list_id: 3, subject: "vendu", price_cents: 100, ad_type: "offer", status: "sold" },
        { list_id: 4, subject: "pro", price_cents: 100, ad_type: "offer", status: "active", owner: { type: "pro" } },
      ],
    }),
  };
  const privateOnly = leboncoin([["api.leboncoin.fr", ads]]);
  const kept = await privateOnly.search(query({ filters: { owner_type: ["private"] } }));
  assert.deepEqual(kept.items.map((i) => i.itemId), ["1"]);

  const everything = leboncoin([["api.leboncoin.fr", ads]]);
  const all = await everything.search(query());
  assert.deepEqual(all.items.map((i) => i.itemId), ["1", "4"]);
});

test("leboncoin says so when a 200 carries no embedded listings", async () => {
  const adapter = new LeboncoinAdapter({
    transport: "page",
    fetchImpl: stub([["/recherche?", { body: "<html>no data</html>" }]]),
    cookies: cookieJar({}), sleep: noSleep, random: noJitter, maxRetries: 0,
  });
  await assert.rejects(() => adapter.search(query()), /no embedded listing JSON/);
});

test("findAdsInPage survives a renamed JSON path", () => {
  const html =
    '<script id="__NEXT_DATA__" type="application/json">' +
    '{"props":{"pageProps":{"someRenamedNode":{"list":[{"list_id":5,"price_cents":100}]}}}}' +
    "</script>";
  assert.deepEqual(findAdsInPage(html).map((a) => a.list_id), [5]);
  assert.deepEqual(findAdsInPage("<html>nothing</html>"), []);
  assert.deepEqual(findAdsInPage('<script id="__NEXT_DATA__" type="application/json">{oops</script>'), []);
});

test("mock is deterministic and paginates", async () => {
  const adapter = new MockAdapter();
  const first = await adapter.search({ searchText: "pixel 8", page: 1, perPage: 10, order: "relevance" });
  const again = await adapter.search({ searchText: "pixel 8", page: 1, perPage: 10, order: "relevance" });
  const second = await adapter.search({ searchText: "pixel 8", page: 2, perPage: 10, order: "relevance" });
  assert.deepEqual(first.items.map((i) => i.itemId), again.items.map((i) => i.itemId));
  assert.deepEqual(first.items.map((i) => i.price), again.items.map((i) => i.price));
  assert.equal(first.totalEntries, 65); // 60 normal + 3 bargains + 2 junk
  assert.equal(first.items.length, 10);
  assert.notEqual(first.items[0].itemId, second.items[0].itemId);
  assert.equal(first.items[0].favourites, 0);
});

test("unknown marketplaces are rejected", () => {
  assert.throws(() => getAdapter("wallapop"), /unknown marketplace/);
  assert.ok(getAdapter("vinted", { fetchImpl: stub([]) }) instanceof VintedAdapter);
  assert.ok(getAdapter("lbc", { fetchImpl: stub([]) }) instanceof LeboncoinAdapter);
  assert.ok(getAdapter("mock") instanceof MockAdapter);
});

test("challenge detection and Retry-After parsing", () => {
  assert.equal(looksLikeChallenge(403, "geo.captcha-delivery.com", new Headers()), true);
  assert.equal(looksLikeChallenge(403, JSON.stringify({ message: "blocked" }), new Headers()), true);
  assert.equal(looksLikeChallenge(403, "plain forbidden", new Headers()), false);
  assert.equal(looksLikeChallenge(200, "", new Headers()), false);
  assert.equal(looksLikeChallenge(403, "", new Headers({ "x-datadome": "1" })), true);
  assert.equal(retryAfterMs(new Headers({ "Retry-After": "7" })), 7000);
  assert.equal(retryAfterMs(new Headers()), null);
});
