/**
 * One opportunities run, end to end, with fake marketplaces and a fake trend feed.
 *
 * The point of these tests is the part that decides whether the page is usable: a
 * marketplace that refuses, an API without keys, or an unacknowledged site must be
 * a note on one product - never a run that produces a wrong margin or silently
 * stops measuring everything else.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MarketplaceBlocked } from "../src/core/adapters/base.js";
import { normalizeCatalogItem } from "../src/core/catalog.js";
import { makeListing } from "../src/core/models.js";
import { runOpportunityScan, summarizeOpportunities } from "../src/core/opportunity-scan.js";

const listing = (price, marketplace, over = {}) =>
  makeListing({
    marketplace,
    itemId: over.itemId || `${marketplace}-${price}-${Math.random()}`,
    title: over.title || "iphone 13 256 go",
    url: `https://example.invalid/${marketplace}/${price}`,
    price,
    currency: "EUR",
    favourites: over.favourites ?? 4,
  });

/** A marketplace that answers with whatever it was told to answer with. */
function fakeAdapter({ prices = [], total = null, error = null, configured = true, name = "fake" } = {}) {
  const adapter = {
    name,
    configured,
    requestsMade: 0,
    async search(query) {
      adapter.requestsMade += 1;
      adapter.lastQuery = query;
      if (error) throw error instanceof Error ? error : new Error(String(error));
      const items = prices.map((price) => listing(price, name));
      return { marketplace: name, items, page: 1, perPage: 40, totalEntries: total ?? items.length, totalPages: 1 };
    },
  };
  return adapter;
}

const PAGEVIEWS = JSON.stringify({
  items: Array.from({ length: 40 }, (_v, index) => ({
    timestamp: `202601${String(index + 1).padStart(2, "0")}00`,
    views: index < 26 ? 100 : 200,
  })),
});

const products = [
  normalizeCatalogItem({ id: "iphone-13", name: "iPhone 13", keyword: "iphone 13 256", buyMarket: ["vinted", "leboncoin"], resaleSource: "ebay", plausibleMinPrice: 50, plausibleMaxPrice: 600, wikipedia: "IPhone 13" }),
  normalizeCatalogItem({ id: "rtx-3060", name: "RTX 3060", keyword: "rtx 3060", buyMarket: ["vinted"], resaleSource: "ebay", plausibleMinPrice: 50, plausibleMaxPrice: 600 }),
];

const settings = {
  acknowledgeAll: true,
  opportunityPerPage: 40,
  opportunityMaxProducts: 12,
  opportunityMinMargin: 0.15,
  opportunityMinConfidence: "medium",
  trendSources: { wikipedia: true, gdelt: false },
  socialKeywords: ["iphone 13"],
};

test("a run samples both sides, reads the trend, and ranks the result", async () => {
  const built = [];
  const { opportunities, summary } = await runOpportunityScan({
    catalog: products,
    settings,
    adapterFactory: ({ marketplace }) => {
      built.push(marketplace);
      if (marketplace === "ebay") return fakeAdapter({ prices: [300, 310, 320, 330, 340, 350], name: "ebay" });
      return fakeAdapter({ prices: [90, 100, 105, 110, 120, 130, 140, 150, 160, 170, 180, 190], total: 400, name: marketplace });
    },
    trendFetch: async (url) => (url.includes("wikimedia") ? { status: 200, body: PAGEVIEWS } : { status: 404, body: "" }),
    now: () => Date.parse("2026-02-01T12:00:00Z"),
  });

  assert.equal(opportunities.length, 2);
  assert.deepEqual(built.slice(0, 3), ["vinted", "leboncoin", "ebay"]);
  const [best, second] = opportunities;
  assert.equal(best.verdict, "buy");
  assert.equal(best.confidence, "high");
  assert.ok(best.trend > 0.9, `public interest should have been read: ${best.trend}`);
  assert.equal(best.category, "other");
  assert.ok(best.marginPct > 1);
  assert.equal(summary.verdicts.buy, 2);
  assert.equal(summary.products, 2);
  assert.ok(summary.requests >= 5, `expected buy+resale requests to be counted, got ${summary.requests}`);
  assert.ok(second.name === "RTX 3060");
});

test("one refusing marketplace is a note on that product, not a failed run", async () => {
  const notes = [];
  const { opportunities, notes: runNotes } = await runOpportunityScan({
    catalog: [products[0]],
    settings,
    adapterFactory: ({ marketplace }) =>
      marketplace === "leboncoin"
        ? fakeAdapter({ error: new MarketplaceBlocked("leboncoin refused (DataDome challenge)"), name: "leboncoin" })
        : fakeAdapter({ prices: marketplace === "ebay" ? [300, 310, 320, 330, 340, 350] : [90, 100, 105, 110, 120, 130, 140, 150, 160, 170, 180, 190], name: marketplace }),
    trendFetch: async () => ({ status: 404, body: "" }),
    now: () => Date.parse("2026-02-01T12:00:00Z"),
  });

  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0].verdict, "buy", "the surviving buy side is still enough");
  assert.match(opportunities[0].errors.join(" "), /leboncoin: unavailable/);
  assert.ok(runNotes.some((note) => /leboncoin/.test(note) && /open leboncoin in a tab/.test(note)));
  void notes;
});

test("an unacknowledged marketplace is skipped before any request is made", async () => {
  const built = [];
  const { opportunities, notes } = await runOpportunityScan({
    catalog: [
      normalizeCatalogItem({
        id: "iphone-13",
        name: "iPhone 13",
        keyword: "iphone 13",
        buyMarket: ["vinted"],
        resaleSource: "ebay",
        plausibleMinPrice: 50,
        plausibleMaxPrice: 600,
      }),
    ],
    settings: { ...settings, acknowledgeAll: false },
    adapterFactory: ({ marketplace }) => {
      built.push(marketplace);
      return fakeAdapter({ prices: [100], name: marketplace });
    },
    trendFetch: null,
    now: () => Date.parse("2026-02-01T12:00:00Z"),
  });

  assert.deepEqual(built, ["ebay"], "only the documented API is used without acknowledgement");
  assert.match(notes.join(" "), /not acknowledged|its terms are not acknowledged/);
  assert.equal(opportunities[0].verdict, "insufficient data");
});

test("eBay without a keyset is reported as needing credentials, not as 'no data'", async () => {
  const searches = [];
  const { opportunities, notes } = await runOpportunityScan({
    catalog: [products[0]],
    settings,
    adapterFactory: ({ marketplace }) => {
      const adapter = fakeAdapter({ prices: [300, 310, 320], name: marketplace, configured: marketplace !== "ebay" });
      const original = adapter.search;
      adapter.search = async (query) => {
        searches.push(marketplace);
        return original(query);
      };
      if (marketplace === "ebay") adapter.name = "ebay";
      return adapter;
    },
    trendFetch: null,
    now: () => Date.parse("2026-02-01T12:00:00Z"),
  });
  assert.deepEqual(searches, ["vinted", "leboncoin"], "no request is made to an unconfigured API");
  assert.match(notes.join(" "), /ebay needs credentials/);
  assert.match(opportunities[0].reasons.join(" "), /no resale price/);
});

test("a manual resale price removes the resale request entirely", async () => {
  const searches = [];
  const product = normalizeCatalogItem({
    id: "iphone-13",
    name: "iPhone 13",
    keyword: "iphone 13",
    buyMarket: ["vinted"],
    resaleSource: "manual",
    manualResalePrice: 320,
    plausibleMinPrice: 50,
    plausibleMaxPrice: 600,
  });
  const { opportunities, summary } = await runOpportunityScan({
    catalog: [product],
    settings,
    adapterFactory: ({ marketplace }) => {
      searches.push(marketplace);
      return fakeAdapter({ prices: [100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210], name: marketplace });
    },
    trendFetch: null,
    now: () => Date.parse("2026-02-01T12:00:00Z"),
  });
  assert.deepEqual(searches, ["vinted"]);
  assert.equal(summary.requests, 1);
  assert.equal(opportunities[0].resaleSource, "manual");
  assert.equal(opportunities[0].verdict, "buy");
});

test("the run stays inside its stated request budget and says that it stopped", async () => {
  const catalog = ["a", "b", "c", "d"].map((id, index) =>
    normalizeCatalogItem({ id, name: `Product ${id}`, keyword: `kw ${index}`, buyMarket: ["vinted"], resaleSource: "ebay" }),
  );
  const { summary, opportunities } = await runOpportunityScan({
    catalog,
    settings: { ...settings, opportunityMaxRequests: 3 },
    adapterFactory: ({ marketplace }) => fakeAdapter({ prices: [100, 200, 300], name: marketplace }),
    trendFetch: null,
    now: () => Date.parse("2026-02-01T12:00:00Z"),
  });
  assert.equal(summary.stoppedEarly, true);
  assert.ok(opportunities.length < catalog.length);
  assert.match(summary.errors.join(" "), /per-run budget/);
});

test("the catalogue cap is honest about what it did not sample", async () => {
  const catalog = ["a", "b", "c", "d"].map((id) => normalizeCatalogItem({ id, name: `P${id}`, keyword: id, buyMarket: ["vinted"], resaleSource: "ebay" }));
  const { summary } = await runOpportunityScan({
    catalog,
    settings: { ...settings, opportunityMaxProducts: 2 },
    adapterFactory: ({ marketplace }) => fakeAdapter({ prices: [100, 200], name: marketplace }),
    trendFetch: null,
  });
  assert.equal(summary.products, 2);
  assert.equal(summary.catalogSize, 4);
  assert.equal(summary.skippedByCap, 2);
});

test("the summary names the best opportunity, or admits there is none", () => {
  const summarized = summarizeOpportunities([
    { name: "a", verdict: "buy", score: 0.7 },
    { name: "b", verdict: "skip", score: 0.1 },
  ]);
  assert.equal(summarized.actionable, 1);
  assert.equal(summarized.best.name, "a");
  assert.equal(summarizeOpportunities([]).best, null);
});
