/** Dedupe, re-alert, pruning and caching rules - the part that decides what you get told. */

import test from "node:test";
import assert from "node:assert/strict";

import { Store, memoryBackend, RE_ALERT_DROP } from "../src/core/storage.js";
import { makeListing, normalizeWatch } from "../src/core/models.js";

function deal(price, { itemId = "1", watch = "w", marketplace = "mock", marketPrice = 200, at = null } = {}) {
  const listing = makeListing({
    marketplace, itemId, title: `item ${itemId}`,
    url: `https://example.invalid/${itemId}`, price, currency: "EUR",
  });
  return {
    watch,
    listing,
    marketPrice,
    discountPct: 1 - price / marketPrice,
    robustZ: -2,
    reasons: ["test"],
    firstSeen: at || "2026-01-01T00:00:00.000Z",
  };
}

async function freshStore(options = {}) {
  const backend = memoryBackend();
  const store = await new Store(backend, options).init();
  return { store, backend };
}

test("a new bargain is reported once, and again only if it gets cheaper", async () => {
  const { store } = await freshStore();
  assert.equal(await store.markAlert(deal(100)), true);
  assert.equal(await store.markAlert(deal(100)), false);          // same price: silent
  assert.equal(await store.markAlert(deal(99)), false);           // 1% drop: still silent
  assert.equal(await store.markAlert(deal(94)), true);            // 6% drop: report again
  assert.equal(await store.markAlert(deal(94)), false);
  assert.equal(store.recentAlerts().length, 1);                   // one row, updated
  assert.equal(store.recentAlerts()[0].price, 94);
  assert.equal(store.recentAlerts()[0].firstSeen, "2026-01-01T00:00:00.000Z");
});

test(`a re-alert needs a ${RE_ALERT_DROP * 100}% drop`, async () => {
  const { store } = await freshStore();
  await store.markAlert(deal(100));
  assert.equal(await store.markAlert(deal(100 * (1 - RE_ALERT_DROP) + 0.01)), false);
  assert.equal(await store.markAlert(deal(100 * (1 - RE_ALERT_DROP))), true);
});

test("a bought or hidden bargain is never reported again", async () => {
  const { store } = await freshStore();
  await store.markAlert(deal(100));
  const key = store.recentAlerts()[0].key;

  await store.setDealStatus(key, "bought");
  assert.equal(await store.markAlert(deal(50)), false, "even a 50% drop must stay quiet");

  await store.setDealStatus(key, "hidden");
  assert.equal(await store.markAlert(deal(10)), false);
  assert.equal(store.recentAlerts({ status: "hidden" }).length, 1);
  assert.equal(store.recentAlerts({ status: "new" }).length, 0);
});

test("the same item can be a bargain for two different watches", async () => {
  const { store } = await freshStore();
  assert.equal(await store.markAlert(deal(100, { watch: "a" })), true);
  assert.equal(await store.markAlert(deal(100, { watch: "b" })), true);
  assert.equal(store.recentAlerts().length, 2);
  assert.equal(store.recentAlerts({ watch: "a" }).length, 1);
});

test("listings are noted once per watch and pruned by count", async () => {
  const { store } = await freshStore({ limits: { seenPerWatch: 3, alerts: 2, log: 2 } });
  const listing = (id) => makeListing({ marketplace: "mock", itemId: id, title: "t", url: "u", price: 10, currency: "EUR" });
  assert.equal(await store.noteListing(listing("a"), "w"), true);
  assert.equal(await store.noteListing(listing("a"), "w"), false);
  for (const id of ["b", "c", "d"]) await store.noteListing(listing(id), "w");
  assert.deepEqual(Object.keys(store.data.seen.w), ["mock:b", "mock:c", "mock:d"]); // "a" pruned
});

test("alerts and the log are capped", async () => {
  const { store } = await freshStore({ limits: { seenPerWatch: 10, alerts: 2, log: 2 } });
  for (const id of ["1", "2", "3"]) {
    await store.markAlert(deal(100, { itemId: id, at: `2026-01-0${id}T00:00:00.000Z` }));
  }
  assert.equal(store.recentAlerts().length, 2);
  for (const n of [1, 2, 3]) await store.appendLog({ message: `event ${n}` });
  assert.equal(store.data.log.length, 2);
  assert.equal(store.data.log[0].message, "event 3"); // newest first
});

test("baselines are cached and expire", async () => {
  const { store } = await freshStore();
  const stats = { median: 100, usedSize: 10, currency: "EUR", mad: 5, sampleSize: 12 };
  await store.saveBaseline("w", stats, [{ itemId: "1" }]);
  assert.equal(store.getBaseline("w", 900).stats.median, 100);
  assert.equal(store.getBaseline("w", -1).stats.median, 100);       // negative ttl = never expires
  assert.equal(store.getBaseline("nope", 900), null);

  store.data.baselines.w.computedAt = new Date(Date.now() - 10_000).toISOString();
  assert.equal(store.getBaseline("w", 5), null);                    // stale
  assert.equal(store.getBaseline("w", null).stats.median, 100);     // ttl null = ignore age
});

test("state survives a reload through the backend", async () => {
  const { store, backend } = await freshStore();
  await store.setWatches([normalizeWatch({ name: "w", searchText: "x" })]);
  await store.markAlert(deal(100));

  const reopened = await new Store(backend).init();
  assert.deepEqual(reopened.watches.map((w) => w.name), ["w"]);
  assert.equal(reopened.recentAlerts().length, 1);
});

test("deleting a watch drops its cached state", async () => {
  const { store } = await freshStore();
  await store.setWatches([normalizeWatch({ name: "a", searchText: "x" }), normalizeWatch({ name: "b", searchText: "y" })]);
  await store.saveBaseline("a", { median: 1, usedSize: 1, currency: "EUR", mad: 0, sampleSize: 1 }, []);
  await store.recordRun("a", { deals: 0 });
  await store.noteListing(makeListing({ marketplace: "mock", itemId: "1", title: "t", url: "u", price: 1, currency: "EUR" }), "a");

  await store.setWatches([normalizeWatch({ name: "b", searchText: "y" })]);
  assert.equal(store.getBaseline("a", null), null);
  assert.equal(store.data.runs.a, undefined);
  assert.equal(store.data.seen.a, undefined);
});

test("settings merge over the defaults", async () => {
  const { store } = await freshStore();
  assert.equal(store.settings.intervalMinutes, 15);
  await store.setSettings({ intervalMinutes: 5 });
  assert.equal(store.settings.intervalMinutes, 5);
  assert.equal(store.settings.perPage, 96); // untouched default survives
});

test("clearAlerts can be scoped to one watch", async () => {
  const { store } = await freshStore();
  await store.markAlert(deal(100, { watch: "a" }));
  await store.markAlert(deal(100, { watch: "b" }));
  assert.equal(await store.clearAlerts({ watch: "a" }), 1);
  assert.deepEqual(store.recentAlerts().map((a) => a.watch), ["b"]);
});

test("starring a deal survives a re-alert and can be cleared around", async () => {
  const { store } = await freshStore();
  await store.markAlert(deal(100));
  const key = store.recentAlerts()[0].key;
  assert.equal(store.recentAlerts()[0].favourite, false, "deals start unstarred");

  await store.setFavourite(key, true);
  assert.deepEqual(store.favourites().map((a) => a.key), [key]);

  // A cheaper price means a new alert row; the star is the user's, so it stays.
  await store.markAlert(deal(80));
  assert.equal(store.recentAlerts()[0].favourite, true);
  assert.equal(store.recentAlerts()[0].price, 80);

  await store.setDealStatus(key, "bought");
  assert.equal(store.favourites().length, 1, "a bought deal can still be a favourite");

  assert.equal(await store.setFavourite("nope|mock|1", true), null);
  assert.equal(await store.clearAlerts({ keepFavourites: true }), 0);
  await store.markAlert(deal(100, { itemId: "other" }));
  assert.equal(await store.clearAlerts({ keepFavourites: true }), 1);
  assert.equal(store.favourites().length, 1);
});

test("every scan pass is kept as a history row, capped on the oldest end", async () => {
  const { store } = await freshStore({ limits: { seenPerWatch: 10, alerts: 10, log: 10, history: 2, opportunityRuns: 2, opportunities: 2 } });
  await store.recordRun("pixel", { at: "2026-01-01T00:00:00.000Z", marketplace: "mock", marketPrice: 200, currency: "EUR", comparables: 63, deals: 3, newDeals: 2, requests: 4 });
  await store.recordRun("pixel", { at: "2026-01-02T00:00:00.000Z", marketPrice: 190, comparables: 40, deals: 0, newDeals: 0, requests: 1, error: "blocked", message: "DataDome" });
  await store.recordRun("dyson", { at: "2026-01-03T00:00:00.000Z", marketPrice: null, comparables: 0, deals: 0, newDeals: 0, requests: 2 });

  const history = store.recentHistory();
  assert.deepEqual(history.map((row) => row.watch), ["dyson", "pixel"], "newest first, capped at the limit");
  assert.equal(history[0].kind, "watch");
  assert.equal(store.recentHistory({ watch: "pixel" }).length, 1);
  assert.equal(store.recentHistory({ kind: "watch" }).length, 2);
  // The run summary the dashboard reads per watch is still there.
  assert.equal(store.data.runs.pixel.deals, 0);
});

test("opportunity runs and their results are stored, and land in the history too", async () => {
  const { store } = await freshStore({ limits: { seenPerWatch: 10, alerts: 10, log: 10, history: 10, opportunityRuns: 1, opportunities: 2 } });
  await store.setCatalog([{ id: "iphone-13", name: "iPhone 13" }]);
  assert.equal(store.data.catalog.length, 1);

  await store.saveOpportunities([
    { id: "a", verdict: "buy", score: 0.7 },
    { id: "b", verdict: "skip", score: 0.1 },
    { id: "c", verdict: "watch", score: 0.4 },
  ]);
  assert.deepEqual(store.data.opportunities.map((o) => o.id), ["a", "b"], "capped");

  await store.recordOpportunityRun({ products: 12, verdicts: { buy: 2, watch: 1 }, requests: 40, errors: ["note"] });
  assert.equal(store.data.opportunityRuns.length, 1);
  const [row] = store.recentHistory({ kind: "opportunities" });
  assert.equal(row.products, 12);
  assert.equal(row.deals, 2, "buy verdicts are the history's deal count");
  assert.equal(row.error, "failed");
  await store.recordOpportunityRun({ products: 3, verdicts: { buy: 0 }, requests: 1, errors: [] });
  assert.equal(store.data.opportunityRuns.length, 1, "capped");
  assert.equal(store.data.opportunityRuns[0].products, 3);
});
