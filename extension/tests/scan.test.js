/** End-to-end scan behaviour on the offline marketplace: the pipeline, not the parts. */

import test from "node:test";
import assert from "node:assert/strict";

import { MockAdapter } from "../src/core/adapters/mock.js";
import { MarketplaceBlocked } from "../src/core/adapters/base.js";
import { VintedAdapter } from "../src/core/adapters/vinted.js";
import { normalizeWatch } from "../src/core/models.js";
import { scanAll, scanWatch, skipReason, summarize } from "../src/core/scan.js";
import { Store, memoryBackend } from "../src/core/storage.js";

const WATCH = normalizeWatch({
  name: "pixel",
  searchText: "pixel 8",
  marketplace: "mock",
  minDiscount: 0.3,
  maxRobustZ: null,
  minSampleSize: 10,
  plausibleMinPrice: 20,
  plausibleMaxPrice: 2000,
});

async function storeWith(limits) {
  return new Store(memoryBackend(), { limits }).init();
}

test("a pass finds the planted bargains and marks them new", async () => {
  const store = await storeWith();
  const adapter = new MockAdapter();
  const report = await scanWatch({ watch: WATCH, adapter, store });

  assert.equal(report.error, null);
  assert.ok(report.stats.median > 150 && report.stats.median < 250);
  assert.equal(report.stats.currency, "EUR");
  // the three planted bargains (45%, 40%, 35% below the base price) must be found
  const planted = report.deals.filter((d) => /deal-\d$/.test(d.listing.itemId));
  assert.equal(planted.length, 3);
  assert.deepEqual(
    planted.map((d) => d.listing.price).sort((a, b) => a - b),
    [110, 120, 130],
  );
  assert.equal(report.newDeals.length, report.deals.length);
  assert.equal(report.requestsMade, 4); // 3 baseline pages (samplePages) + 1 freshness page
  // best discount first, and the junk listings (price 1.0) never qualify
  assert.ok(report.deals[0].discountPct >= report.deals.at(-1).discountPct);
  assert.ok(report.deals.every((d) => d.listing.price > WATCH.plausibleMinPrice));
  assert.equal(store.recentAlerts().length, report.deals.length);
});

test("the second pass reuses the cached baseline and stays quiet", async () => {
  const store = await storeWith();
  const adapter = new MockAdapter();
  await scanWatch({ watch: WATCH, adapter, store });
  const second = await scanWatch({ watch: WATCH, adapter, store });

  assert.equal(second.requestsMade, 1); // baseline came from cache: only the fresh page
  assert.ok(second.deals.length >= 3);
  assert.equal(second.newDeals.length, 0);
  assert.ok(second.notes.some((n) => n.includes("reused from cache")));
});

test("a further price drop re-alerts, and only that item", async () => {
  const store = await storeWith();
  const adapter = new MockAdapter();
  const first = await scanWatch({ watch: WATCH, adapter, store });
  const target = first.deals.find((d) => d.listing.itemId.endsWith("deal-0")).listing;

  // The same market, except that one bargain is now 20% cheaper than when we
  // first reported it. `market` is a plain object keyed by search text.
  const pool = adapter.generate(WATCH.searchText).map((l) =>
    l.itemId === target.itemId ? { ...l, price: Math.round(l.price * 0.8 * 100) / 100 } : l,
  );
  const cheaper = new MockAdapter({ market: { [WATCH.searchText]: pool } });
  // Snapshot what we told the user before the pass: after it, dropped prices have
  // already been written back, so comparing against the live record proves nothing.
  const before = new Map(store.recentAlerts().map((a) => [a.itemId, a.price]));
  const second = await scanWatch({ watch: WATCH, adapter: cheaper, store, forceBaseline: true });

  assert.ok(second.newDeals.some((d) => d.listing.itemId === target.itemId));
  for (const deal of second.newDeals) {
    const previousPrice = before.get(deal.listing.itemId);
    if (previousPrice === undefined) continue; // a bargain we had never seen may alert
    assert.ok(deal.listing.price <= previousPrice * 0.95, "only real drops re-alert");
  }
});

test("a thin market refuses to judge instead of guessing", async () => {
  const store = await storeWith();
  const watch = { ...WATCH, minSampleSize: 500 };
  const report = await scanWatch({ watch, adapter: new MockAdapter(), store });
  assert.deepEqual(report.deals, []);
  assert.ok(report.notes.some((n) => n.includes("no verdict")));
});

test("mixed currencies are never averaged together", async () => {
  const store = await storeWith();
  const base = new MockAdapter();
  const pool = base.generate(WATCH.searchText);
  const mixed = pool.map((l, i) => (i % 3 === 0 ? { ...l, currency: "GBP" } : l));
  const adapter = new MockAdapter({ market: { [WATCH.searchText]: mixed } });
  const report = await scanWatch({ watch: WATCH, adapter, store });

  assert.equal(report.stats.currency, "EUR");
  assert.ok(report.notes.some((n) => n.includes("other currencies")));
  assert.ok(report.comparables.every((c) => c.currency === "EUR"));
  assert.ok(report.deals.every((d) => d.listing.currency === "EUR"));
});

test("an unacknowledged unofficial marketplace is skipped, not silently used", async () => {
  const store = await storeWith();
  const watch = normalizeWatch({ name: "unsafe", searchText: "nike", marketplace: "vinted" });
  // scanAll never even builds an adapter for a watch it is going to skip.
  let adaptersBuilt = 0;
  const reports = await scanAll({
    watches: [watch],
    store,
    settings: {},
    adapterFactory: () => {
      adaptersBuilt += 1;
      return new MockAdapter();
    },
  });
  const report = reports[0];
  assert.ok(report.notes.some((n) => n.includes("not acknowledged")));
  assert.equal(report.requestsMade, 0);
  assert.equal(adaptersBuilt, 0);
  assert.match(skipReason(watch, {}) ?? "", /not acknowledged/);
  assert.equal(skipReason(watch, { acknowledgeAll: true }), null);
  assert.equal(skipReason({ ...watch, enabled: false }, {}), "disabled");
});

test("a blocked marketplace does not stop the others", async () => {
  const store = await storeWith();
  const blockedWatch = normalizeWatch({ name: "blocked", searchText: "iphone", marketplace: "vinted", acknowledgeTerms: true });
  const healthyWatch = { ...WATCH, name: "healthy" };
  await store.setWatches([blockedWatch, healthyWatch]);

  const refused = { status: 403, body: JSON.stringify({ code: "FORBIDDEN" }) };
  const fetchImpl = async (url) => ({
    status: String(url).includes("api.vinted.fr") ? refused.status : 200,
    body: String(url).includes("api.vinted.fr") ? refused.body : "{}",
    headers: new Headers(),
  });

  const reports = await scanAll({
    watches: [blockedWatch, healthyWatch],
    store,
    settings: { perPage: 96 },
    adapterFactory: (watch) =>
      watch.marketplace === "vinted"
        ? new VintedAdapter({ fetchImpl, cookies: async () => null, sleep: () => Promise.resolve(), random: () => 0.5, maxRetries: 1 })
        : new MockAdapter(),
  });

  assert.equal(reports.length, 2);
  assert.equal(reports[0].error, "blocked");
  assert.match(reports[0].errors[0], /refused/);
  assert.equal(reports[1].error, null);
  assert.ok(reports[1].newDeals.length >= 3);            // the healthy watch still delivered
  assert.equal(store.recentAlerts({ watch: "healthy" }).length, reports[1].newDeals.length);
  assert.equal(store.data.log[0].level, "error");        // and it was logged
  const summary = summarize(reports);
  assert.equal(summary.newDeals, reports[1].newDeals.length);
  assert.equal(summary.errors.length, 1);
});

test("the exact-phrase gate is applied to the pool, and says how much it removed", async () => {
  const store = await storeWith();
  // Same generated market, but only some titles mention the phrase.
  const base = new MockAdapter();
  // A third of the ordinary listings are "accessories": same search text would have
  // matched them loosely, but they never mention the phrase.
  const pool = base.generate(WATCH.searchText).map((listing) => {
    const ordinary = /std-\d+$/.test(listing.itemId) && Number(listing.itemId.split("-").pop()) % 3 === 0;
    return ordinary ? { ...listing, title: "coque et accessoire telephone", description: "autre chose" } : listing;
  });
  const adapter = new MockAdapter({ market: { [WATCH.searchText]: pool } });
  const watch = normalizeWatch({
    name: "exact",
    searchText: WATCH.searchText,
    marketplace: "mock",
    exactPhrase: true,
    minDiscount: 0.3,
    maxRobustZ: null,
    minSampleSize: 10,
    plausibleMinPrice: 20,
    plausibleMaxPrice: 2000,
  });
  const report = await scanWatch({ watch, adapter, store });
  assert.ok(report.notes.some((note) => /exact phrase "pixel 8" removed \d+/.test(note)), report.notes.join(" | "));
  assert.ok(
    report.comparables.every((listing) => listing.title.includes(WATCH.searchText)),
    "every comparable mentions the phrase",
  );
  // Half the pool is now junk titles, so the planted bargains must still be found.
  assert.ok(report.deals.length >= 3);
});

test("a watch on the official eBay API is skipped until keys are configured", async () => {
  const store = await storeWith();
  const watch = normalizeWatch({ name: "ebay-phone", searchText: "iphone 13 256", marketplace: "ebay" });
  assert.match(skipReason(watch, {}) ?? "", /needs credentials/);
  assert.equal(skipReason(watch, { credentials: { ebay: true } }), null);

  let adaptersBuilt = 0;
  const reports = await scanAll({
    watches: [watch],
    store,
    settings: { credentials: { ebay: false } },
    adapterFactory: () => {
      adaptersBuilt += 1;
      return new MockAdapter();
    },
  });
  assert.equal(adaptersBuilt, 0, "no request is made to an API we cannot authenticate");
  assert.match(reports[0].notes.join(" "), /developer\.ebay\.com|keyset|credentials/);
});

test("a marketplace error is reported on the watch, never thrown", async () => {
  const store = await storeWith();
  const exploding = {
    name: "mock",
    async search() {
      throw new Error("marketplace exploded");
    },
  };
  const report = await scanWatch({ watch: WATCH, adapter: exploding, store });
  assert.equal(report.error, "failed");
  assert.match(report.errors[0], /exploded/);
  assert.equal(report.stats, null);
});

test("scans run one after another and record what happened", async () => {
  const store = await storeWith();
  const watches = [WATCH, { ...WATCH, name: "second", searchText: "pixel 9" }];
  const reports = await scanAll({
    watches,
    store,
    settings: { perPage: 96 },
    adapterFactory: () => new MockAdapter(),
  });
  assert.deepEqual(reports.map((r) => r.watch), ["pixel", "second"]);
  assert.ok(store.data.runs.pixel.deals >= 3);
  assert.equal(store.data.runs.second.requests, 4);
  assert.ok(store.data.runs.pixel.marketPrice > 0);
});
