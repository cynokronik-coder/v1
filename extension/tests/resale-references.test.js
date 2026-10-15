/**
 * Several marketplaces pricing the sell side at once.
 *
 * This is the difference between "eBay says 320, so it is worth 320" and "eBay says
 * 320, Back Market says 199, momox says 180 - so 180 is the number that survives
 * contact with a buyer". The rule under test is deliberately the unflattering one:
 * the cheapest credible reference wins.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { conservativeResale, computeOpportunity } from "../src/core/opportunity.js";
import { normalizeCatalogItem, estimatedRequests } from "../src/core/catalog.js";
import { makeListing } from "../src/core/models.js";
import { ProviderError } from "../src/core/providers.js";
import { resaleSourcesFor, runOpportunityScan } from "../src/core/opportunity-scan.js";

const listing = (price, marketplace) =>
  makeListing({
    marketplace,
    itemId: `${marketplace}-${price}`,
    title: "iphone 13 128",
    url: `https://example.invalid/${marketplace}/${price}`,
    price,
    currency: "EUR",
  });

function fakeAdapter(prices, name) {
  return {
    name,
    configured: true,
    requestsMade: 0,
    async search() {
      this.requestsMade += 1;
      const items = prices.map((price) => listing(price, name));
      return { marketplace: name, items, page: 1, perPage: 40, totalEntries: items.length, totalPages: 1 };
    },
  };
}

const product = normalizeCatalogItem({
  id: "iphone-13",
  name: "iPhone 13",
  keyword: "iphone 13 128",
  buyMarket: ["vinted", "leboncoin"],
  resaleSource: "ebay",
  resaleSources: ["ebay", "backmarket", "momox"],
  plausibleMinPrice: 50,
  plausibleMaxPrice: 900,
});

const settings = {
  acknowledgeAll: true,
  opportunityPerPage: 40,
  opportunityMaxProducts: 12,
  opportunityMinMargin: 0.15,
  opportunityMinConfidence: "medium",
  trendSources: { wikipedia: false, gdelt: false },
  sources: {},
};

test("conservativeResale quotes the cheapest credible reference, and shows its work", () => {
  const result = conservativeResale({
    resaleBySource: {
      ebay: [300, 310, 320, 330, 340, 350],
      backmarket: [199, 205, 210],
      momox: [180, 185, 190, 195],
    },
  });
  assert.equal(result.source, "momox");
  assert.equal(result.price, 187.5);
  assert.deepEqual(
    result.references.map((entry) => entry.id),
    ["momox", "backmarket", "ebay"],
    "references are ordered cheapest first",
  );
  assert.deepEqual(result.references.map((entry) => entry.count), [4, 3, 6]);
  assert.equal(result.spread, 325 - 187.5, "the spread between the best and worst credible reference");

  assert.equal(conservativeResale({ resaleBySource: { ebay: [] } }), null);
  assert.equal(conservativeResale({}), null);
  // A reference with nothing in it cannot win by being cheap.
  assert.equal(conservativeResale({ resaleBySource: { ebay: [300], momox: [] } }).source, "ebay");
});

test("one reference behaves exactly as before, several references quote the cheapest", () => {
  const buy = { itemId: "a", title: "x", price: 100 };
  const base = {
    product,
    buyListings: [listing(100, "vinted"), listing(110, "vinted"), listing(90, "leboncoin")],
    settings,
  };

  // One reference: the median, and the product's own named source.
  const single = computeOpportunity({
    ...base,
    resaleListings: [listing(300, "ebay"), listing(320, "ebay"), listing(310, "ebay")],
    resaleBySource: { ebay: [listing(300, "ebay"), listing(320, "ebay"), listing(310, "ebay")] },
  });
  assert.equal(single.resaleSource, "ebay");
  assert.equal(single.resalePrice, 310);
  assert.deepEqual(single.resaleReferences, [], "one reference needs no table");

  // Several: the cheapest credible one, plus the full table.
  const many = computeOpportunity({
    ...base,
    resaleListings: [
      listing(300, "ebay"), listing(320, "ebay"), listing(310, "ebay"),
      listing(199, "backmarket"), listing(205, "backmarket"), listing(210, "backmarket"),
    ],
    resaleBySource: {
      ebay: [listing(300, "ebay"), listing(320, "ebay"), listing(310, "ebay")],
      backmarket: [listing(199, "backmarket"), listing(205, "backmarket"), listing(210, "backmarket")],
    },
  });
  assert.equal(many.resaleSource, "backmarket", "the cheapest credible reference wins");
  assert.equal(many.resalePrice, 205);
  assert.deepEqual(many.resaleReferences, [
    { source: "backmarket", median: 205, sample: 3 },
    { source: "ebay", median: 310, sample: 3 },
  ]);
  assert.ok(many.marginPct < single.marginPct, "quoting the cheap reference must not inflate the margin");
  assert.match(many.reasons.join(" "), /resale references:/);
  assert.match(many.reasons.join(" "), /cheapest credible one is quoted/);
  void buy;
});

test("a manual resale price still overrides every reference", () => {
  const manual = computeOpportunity({
    product,
    buyListings: [listing(100, "vinted"), listing(110, "vinted"), listing(90, "leboncoin")],
    resaleListings: [listing(300, "ebay")],
    resaleBySource: { ebay: [listing(300, "ebay")], backmarket: [listing(200, "backmarket")] },
    manualResalePrice: 250,
    settings,
  });
  assert.equal(manual.resaleSource, "manual");
  assert.equal(manual.resalePrice, 250);
});

test("resaleSourcesFor builds the reference list from the product", () => {
  assert.deepEqual(resaleSourcesFor({ resaleSources: ["ebay", "backmarket"], resaleSource: "ebay" }), ["ebay", "backmarket"]);
  assert.deepEqual(resaleSourcesFor({ resaleSource: "momox" }), ["momox"]);
  assert.deepEqual(resaleSourcesFor({ resaleSources: ["ebay", "ebay"] }), ["ebay"], "deduped");
  assert.deepEqual(resaleSourcesFor({ resaleSource: "manual" }), [], "manual is not a marketplace");
});

test("a run searches every resale reference, and says which one it quoted", async () => {
  const built = [];
  const { opportunities, summary } = await runOpportunityScan({
    catalog: [product],
    settings,
    adapterFactory: ({ marketplace }) => {
      built.push(marketplace);
      if (marketplace === "vinted" || marketplace === "leboncoin") {
        return fakeAdapter([80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190], marketplace);
      }
      if (marketplace === "ebay") return fakeAdapter([300, 310, 320, 330, 340, 350], "ebay");
      if (marketplace === "backmarket") return fakeAdapter([199, 205, 210], "backmarket");
      return fakeAdapter([180, 185, 190, 195], "momox");
    },
    now: () => Date.parse("2026-02-01T12:00:00Z"),
  });

  assert.deepEqual(built, ["vinted", "leboncoin", "ebay", "backmarket", "momox"]);
  const [opportunity] = opportunities;
  assert.equal(opportunity.verdict, "buy");
  assert.equal(opportunity.resaleSource, "momox");
  assert.equal(opportunity.resaleReferences.length, 3);
  assert.ok(summary.requests >= 5, "every reference is a request, and they are counted");
  assert.match(opportunity.reasons.join(" "), /momox 18[0-9]/);
});

test("a data provider can price the sell side, and is labelled as the provider", async () => {
  const { opportunities, summary } = await runOpportunityScan({
    catalog: [product],
    settings,
    adapterFactory: ({ marketplace }) =>
      marketplace === "vinted" || marketplace === "leboncoin"
        ? fakeAdapter([80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190], marketplace)
        : fakeAdapter([300, 310, 320, 330, 340, 350], marketplace),
    providerResale: async () => [listing(150, "google-shopping"), listing(160, "google-shopping")],
    now: () => Date.parse("2026-02-01T12:00:00Z"),
  });

  const [opportunity] = opportunities;
  assert.equal(opportunity.resaleSource, "google-shopping", "Google Shopping was the cheapest credible reference");
  assert.ok(opportunity.resaleReferences.some((entry) => entry.source === "google-shopping"));
  assert.equal(summary.requests, 6, "the provider call is counted too");
});

test("a failing provider is a note, not a lost run - and never a missing resale price", async () => {
  const { opportunities, notes } = await runOpportunityScan({
    catalog: [product],
    settings,
    adapterFactory: ({ marketplace }) =>
      marketplace === "vinted" || marketplace === "leboncoin"
        ? fakeAdapter([80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190], marketplace)
        : fakeAdapter([300, 310, 320, 330, 340, 350], marketplace),
    providerResale: async () => {
      throw new ProviderError("SerpApi Google Shopping failed (HTTP 401)");
    },
    now: () => Date.parse("2026-02-01T12:00:00Z"),
  });

  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0].resalePrice, 325, "the marketplaces still priced it");
  assert.ok(notes.some((note) => /google-shopping/.test(note) && /401/.test(note)));
  assert.match(opportunities[0].errors.join(" "), /google-shopping: unavailable/);
});

test("a Google Trends provider signal is blended into the demand score", async () => {
  const { opportunities } = await runOpportunityScan({
    catalog: [product],
    settings,
    adapterFactory: ({ marketplace }) =>
      marketplace === "vinted" || marketplace === "leboncoin"
        ? fakeAdapter([80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190], marketplace)
        : fakeAdapter([300, 310, 320, 330, 340, 350], marketplace),
    providerTrend: async () => ({ score: 0.9, reasons: ["Google Trends interest rising"] }),
    now: () => Date.parse("2026-02-01T12:00:00Z"),
  });
  const [opportunity] = opportunities;
  assert.ok(opportunity.trend > 0, `expected a trend from the provider, got ${opportunity.trend}`);
  assert.match(opportunity.trendReasons.join(" "), /Google Trends interest rising/);
});

test("a source switched off in the Marketplaces page is skipped, in every run", async () => {
  const built = [];
  const { notes } = await runOpportunityScan({
    catalog: [product],
    settings: { ...settings, sources: { momox: { enabled: false } } },
    adapterFactory: ({ marketplace }) => {
      built.push(marketplace);
      return fakeAdapter([100, 200, 300], marketplace);
    },
    now: () => Date.parse("2026-02-01T12:00:00Z"),
  });
  assert.ok(!built.includes("momox"));
  assert.ok(notes.some((note) => /switched off in the Marketplaces page/.test(note)));
});

test("per-source terms acknowledgement is enough, without ticking the global one", async () => {
  const built = [];
  await runOpportunityScan({
    catalog: [product],
    settings: {
      ...settings,
      acknowledgeAll: false,
      sources: { vinted: { acknowledgeTerms: true }, leboncoin: { acknowledgeTerms: true }, ebay: { acknowledgeTerms: true }, backmarket: { acknowledgeTerms: true }, momox: { acknowledgeTerms: true } },
    },
    adapterFactory: ({ marketplace }) => {
      built.push(marketplace);
      return fakeAdapter([100, 200, 300], marketplace);
    },
    now: () => Date.parse("2026-02-01T12:00:00Z"),
  });
  assert.deepEqual(built, ["vinted", "leboncoin", "ebay", "backmarket", "momox"]);
});

test("the request estimate counts every resale reference, not just one", () => {
  const single = normalizeCatalogItem({ name: "A", keyword: "a", buyMarket: ["vinted"], resaleSource: "ebay" });
  const many = normalizeCatalogItem({
    name: "B",
    keyword: "b",
    buyMarket: ["vinted", "leboncoin", "easycash"],
    resaleSource: "ebay",
    resaleSources: ["backmarket", "momox"],
  });
  assert.equal(estimatedRequests([single]), 2, "one buy request, one resale request");
  assert.equal(estimatedRequests([many]), 6, "three buy requests, three resale references");
  assert.equal(many.resaleSources.length, 3, "the primary source is always included");
  assert.equal(many.resaleSources.includes("ebay"), true);
});
