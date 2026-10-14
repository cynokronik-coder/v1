/**
 * The service worker's real logic, with a fake chrome API: scan -> notify ->
 * badge -> storage, plus the message API the dashboard uses.
 *
 * This is as close to "does the extension work" as a test can get without a
 * browser: everything except the browser's own rendering and networking is here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ALARM_NAME, DEMO_WATCH, OPPORTUNITY_ALARM_NAME, browserFetch, createController } from "../src/background.js";
import { normalizeWatch } from "../src/core/models.js";
import { PAGE_SOURCE_IDS, SOURCES, UNOFFICIAL_SOURCE_IDS } from "../src/core/sources.js";

/** A minimal stand-in for the extension APIs the controller touches. */
function fakeChrome({ initial = {}, cookieValue = "anon-xyz" } = {}) {
  let storage = { ...initial };
  const notifications = [];
  const tabs = [];
  const badge = { text: "", color: null };
  const alarms = new Map();
  return {
    notifications,
    tabs,
    badge,
    alarms,
    storageApi: () => storage,
    api: {
      storage: {
        local: {
          async get() {
            return { ...storage };
          },
          async set(next) {
            storage = { ...next };
          },
        },
      },
      notifications: {
        create(id, options, cb) {
          notifications.push({ id, options });
          cb?.(id);
        },
        clear(id, cb) {
          cb?.(true);
        },
      },
      tabs: {
        async create({ url }) {
          tabs.push(url);
          return { url };
        },
      },
      action: {
        async setBadgeText({ text }) {
          badge.text = text;
        },
        async setBadgeBackgroundColor({ color }) {
          badge.color = color;
        },
      },
      alarms: {
        async create(name, info) {
          alarms.set(name, { name, ...info, scheduledTime: Date.now() + (info.periodInMinutes || 15) * 60000 });
        },
        async get(name) {
          return alarms.get(name) ?? null;
        },
      },
      cookies: {
        get({ name }, cb) {
          cb(name === "anon_id" ? { value: cookieValue } : null);
        },
      },
      runtime: {
        getURL: (path) => `chrome-extension://abcdefghijklmnop/${path}`,
        lastError: null,
        id: "abcdefghijklmnop",
      },
    },
  };
}

/** A fetch stub: the offline mock never calls it, so tests can be exact. Replies
 *  are normalised to the {status, body, headers} shape a real fetch always has, so
 *  a route that omits `status` means 200, not "no status". */
function stubFetch(routes = []) {
  const calls = [];
  const impl = async (url) => {
    const asString = String(url);
    calls.push(asString);
    for (const [match, reply] of routes) {
      if (asString.includes(match)) {
        const result = typeof reply === "function" ? reply(asString) : reply;
        return {
          status: result.status ?? 200,
          body: result.body ?? "",
          headers: new Headers(result.headers || {}),
        };
      }
    }
    throw new Error(`unexpected request: ${asString}`);
  };
  impl.calls = calls;
  return impl;
}

async function setup(options = {}) {
  const fake = fakeChrome(options);
  const fetchImpl = options.fetchImpl || stubFetch();
  const sleep = options.sleep || (() => Promise.resolve());
  const controller = createController({ chrome: fake.api, fetchImpl, sleep, random: () => 0.5 });
  await controller.init();
  return { ...fake, controller, fetchImpl, sleep };
}

test("first run seeds the offline demo watch and immediately finds deals", async () => {
  const harness = await setup();
  assert.equal(await harness.controller.seedDemoWatch(), true);
  assert.deepEqual(harness.controller.store.watches.map((w) => w.name), ["pixel".length ? DEMO_WATCH.name : ""]);

  const result = await harness.controller.runScan({ reason: "install", force: true });
  assert.equal(result.ok, true);
  assert.ok(result.summary.deals >= 3);
  assert.equal(result.newDeals, harness.notifications.length);
  assert.equal(harness.badge.text, String(result.newDeals));
  assert.equal(harness.badge.color, "#2ea043");

  // one notification per deal, carrying the listing and the numbers
  const first = harness.notifications[0];
  assert.match(first.options.title, /pixel 8/);
  assert.match(first.options.message, /under/);
  assert.ok(first.options.iconUrl.startsWith("chrome-extension://"));
  assert.ok(first.options.buttons.length === 1);

  // the notification id is the alert key, so a click can find the listing again
  const alert = harness.controller.store.data.alerts[first.id];
  assert.ok(alert && alert.url.includes("example.invalid"));
  assert.equal(JSON.parse(JSON.stringify(alert)).status, "new");
});

test("a second scan is silent, and the badge counts only unseen deals", async () => {
  const harness = await setup();
  await harness.controller.seedDemoWatch();
  const first = await harness.controller.runScan({ force: true });
  const notificationsAfterFirst = harness.notifications.length;

  const second = await harness.controller.runScan();
  assert.equal(second.newDeals, 0);
  assert.equal(harness.notifications.length, notificationsAfterFirst);
  assert.equal(harness.badge.text, String(first.newDeals)); // still unread, so still badged
});

test("marking a deal bought clears it from the badge but keeps it on the page", async () => {
  const harness = await setup();
  await harness.controller.seedDemoWatch();
  await harness.controller.runScan({ force: true });
  const key = harness.notifications[0].id;

  const result = await harness.controller.handleMessage({ type: "setDealStatus", key, status: "bought" });
  assert.equal(result.ok, true);
  assert.equal(result.alert.status, "bought");
  assert.equal(harness.badge.text, String(harness.notifications.length - 1));

  const state = await harness.controller.handleMessage({ type: "getState" });
  assert.equal(state.alerts.filter((a) => a.status === "bought").length, 1);
});

test("clicking a notification opens the listing, even after a worker restart", async () => {
  const harness = await setup();
  await harness.controller.seedDemoWatch();
  await harness.controller.runScan({ force: true });
  const key = harness.notifications[0].id;

  // A restarted worker has an empty in-memory store; it must re-read storage.
  const restarted = createController({ chrome: harness.api, fetchImpl: harness.fetchImpl });
  const resolved = await restarted.handleMessage({ type: "resolveNotification", key });
  assert.equal(resolved.ok, true);
  assert.ok(resolved.url.includes("example.invalid"));
  assert.deepEqual(harness.tabs, [resolved.url]);

  const missing = await restarted.resolveNotification("nope|mock|1");
  assert.equal(missing.ok, false);
});

test("the dashboard can read state, open listings and clear deals", async () => {
  const harness = await setup();
  await harness.controller.seedDemoWatch();
  await harness.controller.runScan({ force: true });

  const state = await harness.controller.handleMessage({ type: "getState" });
  assert.equal(state.watches.length, 1);
  assert.equal(state.settings.intervalMinutes, 15);
  assert.ok(state.alerts.length >= 3);
  assert.ok(state.baselines[DEMO_WATCH.name].stats.median > 0);
  assert.ok(state.nextRunAt > Date.now());
  // Every registry source whose terms are not a documented API, and nothing else.
  assert.deepEqual(
    state.unofficialMarketplaces.sort(),
    [...UNOFFICIAL_SOURCE_IDS].sort(),
  );
  assert.ok(state.unofficialMarketplaces.includes("vinted"));
  assert.ok(!state.unofficialMarketplaces.includes("ebay"), "eBay is the documented one");
  assert.ok(state.log.length >= 1);

  await harness.controller.handleMessage({ type: "openListing", url: "https://www.vinted.fr/items/42" });
  assert.deepEqual(harness.tabs, ["https://www.vinted.fr/items/42"]);

  const cleared = await harness.controller.handleMessage({ type: "clearAlerts" });
  assert.ok(cleared.removed >= 3);
  assert.equal(harness.badge.text, "");
});

test("saving watches validates them, re-arms the alarm and rejects nonsense", async () => {
  const harness = await setup();

  const saved = await harness.controller.handleMessage({
    type: "setWatches",
    watches: [
      { name: "phone", marketplace: "vinted", searchText: "iphone 13", acknowledge_terms: true },
      DEMO_WATCH,
    ],
  });
  assert.equal(saved.watches.length, 2);
  assert.equal(saved.watches[0].acknowledgeTerms, true); // snake_case accepted

  await assert.rejects(
    () => harness.controller.handleMessage({ type: "setWatches", watches: [{ marketplace: "vinted", searchText: "x" }] }),
    /has no name/,
  );
  await assert.rejects(
    () => harness.controller.handleMessage({ type: "setWatches", watches: [{ name: "a", searchText: "x", marketplace: "wallapop" }] }),
    /unknown marketplace/,
  );
  await assert.rejects(() => harness.controller.handleMessage({ type: "nonsense" }), /unknown message type/);

  await harness.controller.handleMessage({ type: "setSettings", settings: { intervalMinutes: 5 } });
  assert.equal(harness.alarms.get(ALARM_NAME).periodInMinutes, 5);
  assert.equal(harness.controller.store.settings.intervalMinutes, 5);

  // A nonsense interval must not disable scanning altogether.
  await harness.controller.handleMessage({ type: "setSettings", settings: { intervalMinutes: 0 } });
  assert.equal(harness.alarms.get(ALARM_NAME).periodInMinutes, 1);
});

test("watching a real marketplace requires acknowledging its terms", async () => {
  const harness = await setup();
  await harness.controller.handleMessage({
    type: "setWatches",
    watches: [{ name: "vinted-phone", marketplace: "vinted", searchText: "iphone 13" }],
  });
  const result = await harness.controller.runScan({ force: true });
  assert.equal(result.summary.deals, 0);
  assert.equal(harness.fetchImpl.calls.length, 0, "a skipped watch must make no requests");
  assert.match(result.reports[0].notes.join(" "), /not acknowledged/);

  const check = await harness.controller.handleMessage({ type: "selfCheck" });
  assert.equal(check.results.length, 1);
  assert.equal(check.results[0].ok, false);
  assert.match(check.results[0].detail, /not tested: this marketplace is not acknowledged/);
});

test("self check reports what actually happens, per marketplace", async () => {
  const vintedApi = {
    body: JSON.stringify({
      items: [{ id: 1, title: "iPhone 13", url: "/items/1", price: { amount: "250.0", currency_code: "EUR" } }],
      pagination: { total_entries: 1, total_pages: 1, current_page: 1, per_page: 5 },
    }),
  };
  const blocked = { status: 403, body: JSON.stringify({ url: "https://geo.captcha-delivery.com/x" }) };
  const harness = await setup({
    fetchImpl: stubFetch([
      ["www.vinted.fr/", { body: "<html></html>" }],
      ["api.vinted.fr", vintedApi],
      ["api.leboncoin.fr", blocked],
      ["/recherche?", blocked],
    ]),
  });
  await harness.controller.handleMessage({
    type: "setWatches",
    watches: [
      { name: "phone", marketplace: "vinted", searchText: "iphone 13", acknowledgeTerms: true },
      { name: "lbc-phone", marketplace: "leboncoin", searchText: "iphone 13", acknowledgeTerms: true },
    ],
  });

  const { results } = await harness.controller.handleMessage({ type: "selfCheck" });
  const byMarket = Object.fromEntries(results.map((r) => [r.marketplace, r]));
  assert.equal(byMarket.vinted.ok, true);
  assert.match(byMarket.vinted.detail, /1 listing\(s\) received.*currency EUR/);
  assert.equal(byMarket.leboncoin.ok, false);
  assert.match(byMarket.leboncoin.detail, /DataDome|refused/);
  assert.match(byMarket.leboncoin.advice, /Browse this marketplace in a normal tab/);
});

test("a blocked marketplace in a scan is logged and does not stop the others", async () => {
  const blocked = { status: 403, body: JSON.stringify({ url: "https://geo.captcha-delivery.com/x" }) };
  const harness = await setup({
    fetchImpl: stubFetch([
      ["www.vinted.fr/", { body: "<html></html>" }],
      ["api.vinted.fr", blocked],
    ]),
  });
  await harness.controller.handleMessage({
    type: "setWatches",
    watches: [
      { name: "real", marketplace: "vinted", searchText: "iphone 13", acknowledgeTerms: true },
      DEMO_WATCH,
    ],
  });
  const result = await harness.controller.runScan({ force: true });
  const byWatch = Object.fromEntries(result.reports.map((r) => [r.watch, r]));
  assert.equal(byWatch.real.error, "blocked");
  assert.ok(byWatch[DEMO_WATCH.name].deals >= 3);
  assert.equal(harness.controller.store.data.log[0].level, "warn");
});

test("notifications can be switched off without stopping scans", async () => {
  const harness = await setup();
  await harness.controller.seedDemoWatch();
  await harness.controller.handleMessage({ type: "setSettings", settings: { notifications: false } });
  const result = await harness.controller.runScan({ force: true });
  assert.ok(result.summary.deals >= 3);
  assert.equal(result.newDeals, 0);
  assert.equal(harness.notifications.length, 0);
});

test("a scan paces requests, and shares that pacing across watches", async () => {
  const waits = [];
  const harness = await setup({
    sleep: (ms) => (waits.push(ms), Promise.resolve()),
    fetchImpl: stubFetch([
      ["www.vinted.fr/", { body: "<html></html>" }],
      [
        "api.vinted.fr",
        {
          body: JSON.stringify({
            items: [{ id: 1, title: "iPhone 13", url: "/items/1", price: { amount: "250.0", currency_code: "EUR" } }],
            pagination: { total_entries: 1, total_pages: 1, current_page: 1, per_page: 5 },
          }),
        },
      ],
    ]),
  });
  await harness.controller.handleMessage({
    type: "setWatches",
    watches: [
      { name: "phone-a", marketplace: "vinted", searchText: "iphone 13", acknowledgeTerms: true },
      { name: "phone-b", marketplace: "vinted", searchText: "iphone 13", acknowledgeTerms: true },
    ],
  });
  await harness.controller.runScan({ force: true });

  // Two watches on one marketplace must not burst: the second watch waits too,
  // even though it got a brand new adapter.
  assert.ok(waits.length >= 2, `expected the second watch to wait too, got ${waits.length} wait(s)`);
  assert.ok(Math.min(...waits) >= 6000, `waits too short: ${waits.join(", ")}`);
});

test("the dashboard's first-run and test-notification buttons work", async () => {
  const harness = await setup();
  const seeded = await harness.controller.handleMessage({ type: "addDemoWatch" });
  assert.equal(seeded.added, true);
  assert.equal(seeded.watches.length, 1);
  // Adding it twice must not duplicate it.
  const again = await harness.controller.handleMessage({ type: "addDemoWatch" });
  assert.equal(again.added, false);
  assert.equal(again.watches.length, 1);

  await harness.controller.handleMessage({ type: "notifyTest" });
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0].options.title, /marketwatch is watching/);
});

test("the catalogue is seeded once, and the opportunities run measures it", async () => {
  const harness = await setup();
  const state = await harness.controller.handleMessage({ type: "getState" });
  assert.ok(state.catalog.length >= 20, "a fresh install has a catalogue to sample");
  assert.equal(await harness.controller.ensureCatalog(), false, "seeding is idempotent");

  // One product, on the offline marketplace, priced by hand: no network needed to
  // prove the run stores a verdict.
  await harness.controller.handleMessage({
    type: "setCatalog",
    catalog: [
      {
        id: "demo-opp",
        name: "Offline demo product",
        keyword: "pixel 8",
        category: "phones",
        buyMarket: ["mock"],
        resaleSource: "manual",
        manualResalePrice: 320,
        plausibleMinPrice: 20,
        plausibleMaxPrice: 2000,
      },
    ],
  });
  await harness.controller.handleMessage({
    type: "setSettings",
    settings: { acknowledgeAll: true, opportunityMinConfidence: "medium", opportunityMinMargin: 0.15 },
  });

  const result = await harness.controller.handleMessage({ type: "scanOpportunities", reason: "test" });
  assert.equal(result.ok, true);
  assert.equal(result.summary.products, 1);
  assert.equal(result.summary.verdicts.buy, 1);
  assert.equal(result.best.name, "Offline demo product");

  const after = await harness.controller.handleMessage({ type: "getState" });
  assert.equal(after.opportunities[0].verdict, "buy");
  assert.equal(after.opportunityRuns.length, 1);
  assert.ok(after.history.some((row) => row.kind === "opportunities"), "the run shows up in the history");
  assert.ok(after.log.some((entry) => /opportunities/.test(entry.message)));
});

test("the opportunities alarm is armed separately, and clamped like the scan one", async () => {
  const harness = await setup();
  assert.equal(harness.alarms.get(OPPORTUNITY_ALARM_NAME).periodInMinutes, 720);
  await harness.controller.handleMessage({ type: "setSettings", settings: { opportunityIntervalMinutes: 90 } });
  assert.equal(harness.alarms.get(OPPORTUNITY_ALARM_NAME).periodInMinutes, 90);
  await harness.controller.handleMessage({ type: "setSettings", settings: { opportunityIntervalMinutes: 0 } });
  assert.equal(harness.alarms.get(OPPORTUNITY_ALARM_NAME).periodInMinutes, 1);
  const state = await harness.controller.handleMessage({ type: "getState" });
  assert.ok(state.nextOpportunityRunAt > Date.now());
});

test("a catalogue the user typed is validated, and a bad one is rejected loudly", async () => {
  const harness = await setup();
  const saved = await harness.controller.handleMessage({
    type: "setCatalog",
    catalog: [{ name: "iPhone 13", keyword: "iphone 13 256", plausibleMinPrice: "100", plausibleMaxPrice: "900" }],
  });
  assert.equal(saved.catalog.length, 1);
  assert.equal(saved.catalog[0].id, "iphone-13");
  assert.equal(saved.catalog[0].plausibleMaxPrice, 900);

  await assert.rejects(
    () => harness.controller.handleMessage({ type: "setCatalog", catalog: [{ name: "broken" }] }),
    /has no keyword/,
  );
  await assert.rejects(
    () => harness.controller.handleMessage({ type: "setCatalog", catalog: [{ name: "x", keyword: "y", resaleSource: "wallapop" }] }),
    /unknown resaleSource/,
  );
});

test("starring a deal is stored, counted, and survives a cheaper re-alert", async () => {
  const harness = await setup();
  await harness.controller.seedDemoWatch();
  await harness.controller.runScan({ force: true });
  const state = await harness.controller.handleMessage({ type: "getState" });
  const key = state.alerts[0].key;

  const starred = await harness.controller.handleMessage({ type: "setFavourite", key, favourite: true });
  assert.equal(starred.ok, true);
  assert.equal(starred.alert.favourite, true);
  assert.equal(starred.alert.status, "new", "starring is not a status change");

  const after = await harness.controller.handleMessage({ type: "getState" });
  assert.equal(after.alerts.filter((alert) => alert.favourite).length, 1);

  const cleared = await harness.controller.handleMessage({ type: "clearAlerts", keepFavourites: true });
  assert.equal(cleared.removed, state.alerts.length - 1);
  const kept = await harness.controller.handleMessage({ type: "getState" });
  assert.equal(kept.alerts.length, 1);
  assert.equal(kept.alerts[0].favourite, true);
  // Starring is not "handled": a starred deal that is still new is still on the badge.
  assert.equal(harness.badge.text, "1");
});

test("the self-check says whether a tab is available to borrow", async () => {
  const harness = await setup();
  const noTabs = await harness.controller.tabStatus();
  // One entry per registry source that has hosts, and none for the ones that do not.
  const withHosts = SOURCES.filter((source) => source.hosts?.length).map((source) => source.id).sort();
  assert.deepEqual(Object.keys(noTabs).sort(), withHosts);
  assert.ok(withHosts.length >= 10, "a ten-marketplace tool should report ten tabs to borrow");
  assert.ok(PAGE_SOURCE_IDS.includes("easycash"), "easycash is a page source");
  assert.equal(Object.values(noTabs).every((value) => value === false), true);

  const withTabs = createController({
    chrome: harness.api,
    fetchImpl: harness.fetchImpl,
    tabTransport: { async available(hosts) { return hosts.some((host) => host.includes("leboncoin")); } },
  });
  const tabs = await withTabs.tabStatus();
  assert.equal(tabs.leboncoin, true);
  assert.equal(tabs.backmarket, false);
  assert.equal(Object.values(tabs).filter(Boolean).length, 1, "leboncoin is on both www and the bare host");
  const state = await withTabs.handleMessage({ type: "getState" });
  assert.deepEqual(state.tabs, tabs);
});

test("browserFetch adapts a real Response into what the adapters consume", async () => {
  const fakeResponse = {
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    url: "https://api.vinted.fr/x",
    async text() {
      return '{"ok":true}';
    },
  };
  const wrapped = browserFetch(async (url, init) => {
    assert.equal(url, "https://example.test/y");
    assert.equal(init.credentials, "include");
    return fakeResponse;
  });
  const result = await wrapped("https://example.test/y", { credentials: "include" });
  assert.equal(result.status, 200);
  assert.equal(result.body, '{"ok":true}');
  assert.equal(result.headers.get("content-type"), "application/json");
});

// --- the wider marketplace list, through the real controller ----------------

const JSONLD_PAGE = `<html><head><script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "ItemList",
  itemListElement: [1200, 1250, 1300, 1350, 1400, 1450, 1500, 1550, 1600, 1650, 1700, 1750].map((price, index) => ({
    "@type": "ListItem",
    item: {
      "@type": "Product",
      name: `Cdiscount lot ${index}`,
      url: `https://www.cdiscount.com/p/${index}`,
      sku: `cd-${index}`,
      offers: { "@type": "Offer", price: String(price), priceCurrency: "EUR" },
    },
  })),
})}</script></head></html>`;

test("a page-based marketplace is scanned by the real worker, and its listings count", async () => {
  const harness = await setup({
    fetchImpl: stubFetch([["www.cdiscount.com/search/10/", { body: JSONLD_PAGE }]]),
  });
  await harness.controller.handleMessage({
    type: "setWatches",
    watches: [
      { name: "iphone-cdiscount", marketplace: "cdiscount", searchText: "iphone 13", acknowledgeTerms: true, minSampleSize: 8, samplePages: 1 },
    ],
  });

  const result = await harness.controller.runScan({ force: true });
  assert.equal(result.ok, true);
  const report = result.reports[0];
  assert.equal(report.error, null, `a page source should scan cleanly: ${report.error}`);
  assert.ok(harness.fetchImpl.calls.some((url) => url === "https://www.cdiscount.com/search/10/iphone%2013.html"));

  const state = await harness.controller.handleMessage({ type: "getState" });
  const baseline = state.baselines["iphone-cdiscount"];
  assert.ok(baseline.comparables.length > 0, "the scraped listings became comparables");
  assert.equal(baseline.comparables[0].marketplace, "cdiscount");
});

test("a page-based marketplace that serves no data is an error on that watch, not a crash", async () => {
  const harness = await setup({
    fetchImpl: stubFetch([["www.cdiscount.com/search/10/", { body: "<html><body>rien</body></html>" }]]),
  });
  await harness.controller.handleMessage({
    type: "setWatches",
    watches: [{ name: "empty", marketplace: "cdiscount", searchText: "iphone 13", acknowledgeTerms: true }],
  });
  const result = await harness.controller.runScan({ force: true });
  // "failed", not "blocked": a page with nothing readable on it is not an anti-bot block.
  assert.equal(result.reports[0].error, "failed");
  assert.match(result.reports[0].notes.join(" "), /no product data could be read/);
});

test("the Sources page's switches and per-source test reach the real worker", async () => {
  const harness = await setup({
    fetchImpl: stubFetch([["www.easycash.fr", { body: JSONLD_PAGE }]]),
  });

  const saved = await harness.controller.handleMessage({
    type: "setSource",
    marketplace: "easycash",
    patch: { enabled: true, acknowledgeTerms: true, urlTemplate: "https://www.easycash.fr/recherche?q={query}" },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.sources.easycash.urlTemplate, "https://www.easycash.fr/recherche?q={query}");

  await assert.rejects(
    () => harness.controller.handleMessage({ type: "setSource", marketplace: "wallapop", patch: { enabled: true } }),
    /unknown source 'wallapop'/,
  );

  // The state dump the dashboard renders: every registry source, with its status.
  const state = await harness.controller.handleMessage({ type: "getState" });
  assert.equal(state.sources.length, SOURCES.length);
  const easycash = state.sources.find((source) => source.id === "easycash");
  assert.equal(easycash.enabled, true);
  assert.equal(easycash.mode, "search-url", "a pasted template promotes it out of open-tab mode");
  assert.equal(easycash.settings.acknowledgeTerms, true);
  const ebay = state.sources.find((source) => source.id === "ebay");
  assert.equal(ebay.status, "needs credentials");
  assert.equal(ebay.credentialReady, false);
  assert.equal(state.providers.length, 4);
  assert.ok(state.providers.every((provider) => provider.configured === false));

  // Testing exactly one source makes exactly one request, to that source.
  const before = harness.fetchImpl.calls.length;
  const check = await harness.controller.handleMessage({ type: "selfCheck", marketplace: "easycash" });
  assert.equal(check.results.length, 1, "one source, one answer");
  assert.equal(check.results[0].marketplace, "easycash");
  assert.equal(check.results[0].ok, true);
  assert.match(check.results[0].detail, /12 listing\(s\) received/);
  assert.match(check.results[0].detail, /via the service worker/);
  assert.equal(harness.fetchImpl.calls.length, before + 1);

  // Switching it off means the scan skips it without a request.
  await harness.controller.handleMessage({ type: "setSource", marketplace: "easycash", patch: { enabled: false } });
  await harness.controller.handleMessage({
    type: "setWatches",
    watches: [{ name: "off", marketplace: "easycash", searchText: "iphone 13", acknowledgeTerms: true }],
  });
  const afterOff = harness.fetchImpl.calls.length;
  const scan = await harness.controller.runScan({ force: true });
  assert.match(scan.reports[0].notes.join(" "), /switched off in the Sources page/);
  assert.equal(harness.fetchImpl.calls.length, afterOff, "a switched-off source makes no requests");
});
