/**
 * The generic page adapter - the thing that turns nine marketplaces into one
 * implementation.
 *
 * The two modes behave very differently on purpose, so both are tested here: a
 * `search-url` source must fetch the URL it built, and an `open-tab` source must
 * build **no URL and make no request at all**. That last one is a promise the tool
 * makes to the user about how it touches a site, so it gets a hard assertion.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createPageAdapter } from "../src/core/adapters/page-source.js";
import { getAdapter } from "../src/core/adapters/index.js";
import { MarketplaceBlocked, MarketplaceError } from "../src/core/adapters/base.js";
import { MODE, sourceById } from "../src/core/sources.js";

const product = (name, price, extra = {}) => ({
  "@type": "Product",
  name,
  url: `https://www.example.fr/p/${encodeURIComponent(name)}`,
  sku: name,
  offers: { "@type": "Offer", price: String(price), priceCurrency: "EUR" },
  ...extra,
});

const page = (...products) =>
  `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: products.map((item) => ({ "@type": "ListItem", item })),
  })}</script></head><body></body></html>`;

const response = (over = {}) => ({ status: 200, body: "", headers: new Headers(), ...over });

/** A pacer that never waits, so tests do not sit through 9-second intervals. */
function fakePacing() {
  return { wait: async () => {}, mark() {}, sleep: async () => {}, backoffMs: () => 1, minIntervalMs: 9000 };
}

function spyFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("a search-url source builds its URL, fetches it, and reads the page", async () => {
  const fetchImpl = spyFetch(() => response({ body: page(product("iPhone 13 128", 249), product("iPhone 13 256", 329)) }));
  const adapter = getAdapter("cdiscount", { fetchImpl, settings: {}, pacing: fakePacing() });

  const result = await adapter.search({ searchText: "iphone 13", page: 1, perPage: 10 });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, "https://www.cdiscount.com/search/10/iphone%2013.html");
  assert.equal(result.items.length, 2);
  assert.equal(result.strategy, "json-ld");
  assert.equal(result.marketplace, "cdiscount");
  assert.equal(adapter.requestsMade, 1);
  // A scraped page is one page of results: no honest total exists, and inventing one
  // would corrupt the demand score.
  assert.equal(result.totalEntries, null);
});

test("the user's own URL template is used when they paste one", async () => {
  const fetchImpl = spyFetch(() => response({ body: page(product("PS5", 400)) }));
  const adapter = getAdapter("easycash", {
    fetchImpl,
    pacing: fakePacing(),
    settings: { sources: { easycash: { urlTemplate: "https://bons-plans.easycash.fr/recherche?q={query}" } } },
  });
  assert.equal(adapter.mode, MODE.SEARCH_URL, "a pasted template promotes an open-tab source");
  const result = await adapter.search({ searchText: "playstation 5" });
  assert.equal(fetchImpl.calls[0].url, "https://bons-plans.easycash.fr/recherche?q=playstation%205");
  assert.equal(result.items.length, 1);
});

test("an open-tab source builds no URL and makes no request", async () => {
  const fetchImpl = spyFetch(() => {
    throw new Error("open-tab mode must never fetch");
  });
  const reads = [];
  const tabTransport = {
    async available() {
      return true;
    },
    async readTabDocument({ hosts }) {
      reads.push(hosts);
      return response({ body: page(product("Bureau en chêne", 120)), url: "https://www.easycash.fr/recherche?s=bureau" });
    },
    async fetchInTab() {
      throw new Error("open-tab mode must not fetch inside the tab either");
    },
  };

  const adapter = getAdapter("easycash", { fetchImpl, tabTransport, settings: {}, pacing: fakePacing() });
  assert.equal(adapter.mode, MODE.OPEN_TAB);
  assert.equal(adapter.searchUrl("bureau"), null, "there is no URL to build: that is the point");

  const result = await adapter.search({ searchText: "bureau" });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0], sourceById("easycash").hosts);
  assert.equal(result.items.length, 1);
  assert.equal(adapter.lastTransport, "your open tab");
  assert.equal(adapter.lastSource, "json-ld", "the strategy and the transport are different facts");
});

test("a page source prefers the user's own open tab when there is one", async () => {
  const fetchImpl = spyFetch(() => response({ body: page(product("from worker", 10)) }));
  const tabTransport = {
    async available() {
      return true;
    },
    async fetchInTab(url) {
      return response({ body: page(product("from tab", 20)), url });
    },
  };
  const adapter = getAdapter("fnac", { fetchImpl, tabTransport, settings: {}, pacing: fakePacing() });
  const result = await adapter.search({ searchText: "iphone 13" });

  assert.equal(fetchImpl.calls.length, 0, "the tab is used, not the worker");
  assert.equal(result.items[0].title, "from tab");
  assert.equal(adapter.lastTransport, "your open tab");
});

test("no open tab means the worker asks, and says so", async () => {
  const fetchImpl = spyFetch(() => response({ body: page(product("from worker", 10)) }));
  const tabTransport = { async available() { return false; } };
  const adapter = getAdapter("fnac", { fetchImpl, tabTransport, settings: {}, pacing: fakePacing() });
  await adapter.search({ searchText: "x" });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(adapter.lastTransport, "the service worker");
});

test("the price band is applied to page results, because the site cannot be trusted to", async () => {
  const fetchImpl = spyFetch(() =>
    response({ body: page(product("cheap", 5), product("fine", 200), product("expensive", 9000)) }),
  );
  const adapter = getAdapter("cdiscount", { fetchImpl, pacing: fakePacing(), settings: {} });
  const result = await adapter.search({ searchText: "x", minPrice: 50, maxPrice: 1000 });
  assert.deepEqual(result.items.map((item) => item.title), ["fine"]);
  assert.equal(result.droppedByBand, 2);
});

test("bot protection is reported as blocked, with the source's own advice", async () => {
  const fetchImpl = spyFetch(() => response({ status: 403, body: "<html>captcha-delivery.com</html>" }));
  const adapter = getAdapter("fnac", { fetchImpl, settings: {}, pacing: fakePacing() });
  await assert.rejects(
    () => adapter.search({ searchText: "x" }),
    (err) => {
      assert.ok(err instanceof MarketplaceBlocked, "a challenge is a block, not a generic failure");
      assert.match(err.message, /Fnac .*refused the request \(HTTP 403/);
      assert.match(err.message, /403 to plain server requests/);
      return true;
    },
  );
});

test("a stale URL template says what to do instead of pretending the market is empty", async () => {
  const fetchImpl = spyFetch(() => response({ status: 404, body: "not found" }));
  const adapter = getAdapter("cdiscount", { fetchImpl, settings: {}, pacing: fakePacing() });
  await assert.rejects(
    () => adapter.search({ searchText: "x" }),
    (err) => {
      assert.match(err.message, /HTTP 404/);
      assert.match(err.message, /URL template .* has probably gone stale/);
      assert.match(err.message, /reads your tab|Marketplaces page/);
      return true;
    },
  );
});

test("HTTP 200 with no product data is an error, never an empty market", async () => {
  const fetchImpl = spyFetch(() => response({ body: "<html><body><h1>Résultats</h1></body></html>" }));
  const adapter = getAdapter("cdiscount", { fetchImpl, settings: {}, pacing: fakePacing() });
  await assert.rejects(() => adapter.search({ searchText: "x" }), /no product data could be read/);
});

test("a sign-in wall gets a sign-in answer", async () => {
  const fetchImpl = spyFetch(() => response({ body: "<html><body>Connectez-vous pour continuer</body></html>" }));
  const adapter = getAdapter("facebook", {
    fetchImpl,
    pacing: fakePacing(),
    settings: { sources: { facebook: { urlTemplate: "https://www.facebook.com/marketplace/search/?query={query}" } } },
  });
  await assert.rejects(() => adapter.search({ searchText: "x" }), /sign-in page instead of results/);
});

test("a tab that is not open is explained, not silently skipped", async () => {
  const fetchImpl = spyFetch(() => response({ body: page(product("x", 10)) }));
  const tabTransport = {
    async available() {
      return false;
    },
    async readTabDocument() {
      const { TabUnavailableError } = await import("../src/core/tab-transport.js");
      throw new TabUnavailableError("no open tab on www.easycash.fr - open the site, run the search yourself, then scan again");
    },
  };
  const adapter = getAdapter("easycash", { fetchImpl, tabTransport, settings: {}, pacing: fakePacing() });
  await assert.rejects(() => adapter.search({ searchText: "x" }), /open the site, run the search yourself/);
});

test("every generic page source can be constructed, and knows its own hosts", () => {
  // The four dedicated adapters keep their own host handling; everything else goes
  // through createPageAdapter.
  for (const id of ["fnac", "cdiscount", "easycash", "cashexpress", "cashconverters", "momox", "facebook"]) {
    const adapter = getAdapter(id, { fetchImpl: async () => response(), settings: {}, pacing: fakePacing() });
    assert.equal(adapter.name, id);
    assert.ok(adapter.configured !== false);
    assert.equal(adapter.source.id, id);
    const source = sourceById(id);
    assert.deepEqual(
      adapter.hosts.map((host) => host.replace(/^www\./, "")),
      source.hosts.map((host) => host.replace(/^www\./, "")),
      `${id} should look for a tab on exactly the hosts the registry lists`,
    );
  }
});

test("the dedicated adapters still have their own implementations", () => {
  for (const [id, expected] of [
    ["vinted", "VintedAdapter"],
    ["leboncoin", "LeboncoinAdapter"],
    ["lbc", "LeboncoinAdapter"],
    ["ebay", "EbayAdapter"],
    ["backmarket", "BackMarketAdapter"],
    ["mock", "MockAdapter"],
  ]) {
    const adapter = getAdapter(id, { fetchImpl: async () => response(), settings: {}, pacing: fakePacing() });
    assert.equal(adapter.constructor.name, expected, `${id} should keep its own adapter`);
  }
});

test("an adapter without a fetch implementation refuses to be built", () => {
  assert.throws(() => createPageAdapter(sourceById("fnac"), {}), /needs a fetch implementation/);
});

test("an unknown marketplace is refused by name, with the real list", () => {
  assert.throws(() => getAdapter("wallapop", {}), /unknown marketplace 'wallapop'/);
  assert.throws(() => getAdapter("wallapop", {}), /easycash/);
});

test("MarketplaceError is not confused with a block", async () => {
  const fetchImpl = spyFetch(() => response({ status: 500, body: "boom" }));
  const adapter = getAdapter("fnac", { fetchImpl, settings: {}, pacing: fakePacing(), maxRetries: 0 });
  await assert.rejects(
    () => adapter.search({ searchText: "x" }),
    (err) => {
      assert.ok(err instanceof MarketplaceError);
      assert.equal(err instanceof MarketplaceBlocked, false);
      return true;
    },
  );
});
