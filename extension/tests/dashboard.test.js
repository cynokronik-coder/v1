/**
 * The dashboard, actually rendered: real HTML, real DOM, fake service worker.
 *
 * jsdom is a dev-only dependency and is not shipped with the extension; it is here
 * because "the UI boots and the buttons do what they say" is exactly the part a
 * node test of pure functions cannot check.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { JSDOM } from "jsdom";

import { fail, ok } from "../src/core/messages.js";

const HTML = readFileSync(new URL("../dashboard.html", import.meta.url), "utf8");

function deal(over = {}) {
  return {
    key: "pixel|mock|1000",
    watch: "pixel",
    marketplace: "mock",
    itemId: "1000",
    title: "pixel 8 - listing 1000",
    url: "https://example.invalid/items/1000",
    imageUrl: "https://example.invalid/1000.jpg",
    price: 110,
    currency: "EUR",
    marketPrice: 200,
    discountPct: 0.45,
    robustZ: -4.1,
    condition: "Bon état",
    size: "128 Go",
    brand: "Google",
    reasons: ["45% under the median"],
    firstSeen: "2026-01-02T00:00:00.000Z",
    status: "new",
    ...over,
  };
}

function opportunity(over = {}) {
  return {
    id: "iphone-13",
    name: "iPhone 13 (128 / 256 Go)",
    category: "phones",
    keyword: "iphone 13 256",
    buyMarket: ["vinted", "leboncoin"],
    resaleSource: "backmarket",
    buyPrice: 180,
    resalePrice: 310,
    profitAbs: 84.4,
    marginPct: 0.47,
    spreadPct: 0.72,
    buySample: 24,
    resaleSample: 9,
    buyUrl: "https://example.invalid/iphone-13",
    currency: "EUR",
    confidence: "high",
    confidenceReason: "24 buy-side and 9 resale listings",
    liquidity: 0.6,
    trend: 0.8,
    score: 0.7,
    verdict: "buy",
    reasons: ["buy at ~180.00 EUR (24 listing(s), 15th percentile)", "after 10% commission and 5.00 shipping: net 268.42 on 180.00 cost = +88.42 EUR (49.1%)"],
    ...over,
  };
}

/** Two registry sources with opposite problems: one ready, one waiting for a key. */
function sourceState() {
  return [
    {
      id: "vinted",
      label: "Vinted",
      kind: "marketplace",
      side: "both",
      access: "page",
      mode: "search-url",
      status: "ready (your tab)",
      detail: "Vinted: requests are made by your own open tab, at 6s intervals.",
      hosts: ["www.vinted.fr"],
      searchHint: "https://www.vinted.fr/catalog?search_text={query}",
      terms: "unofficial",
      termsNote: "Vinted's terms prohibit bots, scraping and crawlers unless Vinted permits them.",
      note: "Private sellers, the cheapest buy side for clothes, phones and consoles.",
      advice: "Vinted rate-limits aggressively: keep the interval at 15 minutes or more.",
      buying: true,
      resale: true,
      enabled: true,
      credentialReady: true,
      credentials: null,
      settings: {},
    },
    {
      id: "ebay",
      label: "eBay (Browse API)",
      kind: "marketplace",
      side: "both",
      access: "official-api",
      mode: "api",
      status: "needs credentials",
      detail: "Free developer account, no seller account and no listing fees.",
      hosts: ["www.ebay.fr"],
      searchHint: "https://www.ebay.fr/sch/i.html?_nkw={query}",
      terms: "documented",
      termsNote: "Documented API under eBay's developer terms.",
      note: "The terms-compliant, documented path.",
      advice: "Paste your Client ID and Client Secret in Settings.",
      buying: true,
      resale: true,
      enabled: true,
      credentialReady: false,
      credentials: { label: "eBay developer keyset", docsUrl: "https://developer.ebay.com/signin", keys: [], missing: ["ebayClientId", "ebayClientSecret"] },
      settings: {},
    },
    {
      id: "facebook",
      label: "Facebook Marketplace",
      kind: "social",
      side: "buy",
      access: "page",
      mode: "open-tab",
      status: "off (terms)",
      detail: "Meta's terms forbid accessing or collecting data by automated means.",
      hosts: ["www.facebook.com"],
      searchHint: "https://www.facebook.com/marketplace/search/?query={query}",
      terms: "prohibited",
      termsNote: "Meta's terms forbid automated collection without permission.",
      note: "Local pickups, often the cheapest source of furniture.",
      advice: "Off by default: read the terms note before enabling it.",
      buying: true,
      resale: false,
      enabled: false,
      credentialReady: true,
      credentials: null,
      settings: {},
    },
  ];
}

function providerState() {
  return [
    {
      id: "apify",
      label: "Apify",
      docsUrl: "https://docs.apify.com/api/v2",
      signupUrl: "https://console.apify.com/sign-up",
      freeTier: "free plan with monthly usage credit",
      what: "Runs one of the marketplace scrapers in its store and returns the dataset as JSON.",
      legal: "Apify's store is not an authorisation layer.",
      covers: ["vinted", "leboncoin"],
      keys: [{ key: "apifyToken", label: "API token", type: "password" }],
      configured: false,
    },
  ];
}

function baseState(over = {}) {
  return {
    watches: [
      {
        name: "pixel",
        marketplace: "mock",
        searchText: "pixel 8",
        minDiscount: 0.3,
        maxRobustZ: -1,
        minSampleSize: 10,
        plausibleMinPrice: 20,
        plausibleMaxPrice: 2000,
        samplePages: 3,
        enabled: true,
        acknowledgeTerms: true,
        mustMatch: [],
        mustNotMatch: [],
        sizes: [],
        conditions: [],
      },
    ],
    settings: {
      intervalMinutes: 15,
      perPage: 96,
      notifications: true,
      leboncoinTransport: "auto",
      acknowledgeAll: false,
      opportunityMinMargin: 0.15,
      opportunityMinConfidence: "medium",
      trendSources: { wikipedia: true, gdelt: false },
      socialKeywords: [],
    },
    alerts: [deal()],
    runs: { pixel: { at: new Date().toISOString(), marketPrice: 200, comparables: 63, error: null } },
    baselines: { pixel: { stats: { median: 200, mad: 25, currency: "EUR", usedSize: 63, rawSize: 70 }, computedAt: "2026-01-02T00:00:00.000Z" } },
    history: [
      { at: new Date().toISOString(), kind: "watch", watch: "pixel", marketplace: "mock", marketPrice: 200, currency: "EUR", comparables: 63, deals: 4, newDeals: 1, requests: 4, error: null, message: null },
      { at: "2026-01-01T00:00:00.000Z", kind: "watch", watch: "pixel", marketplace: "mock", marketPrice: 190, currency: "EUR", comparables: 40, deals: 1, newDeals: 1, requests: 1, error: null, message: null },
      { at: "2026-01-01T00:00:00.000Z", kind: "opportunities", watch: null, products: 2, deals: 1, newDeals: 0, requests: 40, error: null, message: null },
    ],
    catalog: [
      { id: "iphone-13", name: "iPhone 13 (128 / 256 Go)", category: "phones", keyword: "iphone 13 128", buyMarket: ["vinted", "leboncoin"], resaleSource: "backmarket", manualResalePrice: null, plausibleMinPrice: 150, plausibleMaxPrice: 700, wikipedia: "IPhone 13", enabled: true },
    ],
    opportunities: [opportunity(), opportunity({ id: "rtx-3060", name: "RTX 3060", category: "pc-parts", verdict: "skip", score: 0.2, marginPct: 0.02 })],
    opportunityRuns: [{ at: new Date().toISOString(), products: 2, requests: 40, verdicts: { buy: 1, skip: 1 }, errors: [] }],
    tabs: { leboncoin: false, backmarket: false },
    log: [{ level: "info", at: new Date().toISOString(), message: "saved 1 watch(es)" }],
    unofficialMarketplaces: ["vinted", "leboncoin", "backmarket"],
    sources: sourceState(),
    providers: providerState(),
    nextRunAt: Date.now() + 600000,
    nextOpportunityRunAt: Date.now() + 43200000,
    scanning: false,
    opportunityScanning: false,
    ...over,
  };
}

let caseId = 0;

/** Boot dashboard.js against a fresh document and a fake worker. */
async function open({ state = baseState(), selfCheck, onMessage } = {}) {
  const dom = new JSDOM(HTML, { url: "https://dashboard.invalid/dashboard.html" });
  const sent = [];
  const worker = {
    async handle(message) {
      sent.push(message);
      if (onMessage) {
        const reply = await onMessage(message, worker);
        if (reply !== undefined) return reply;
      }
      if (message.type === "getState") return worker.state;
      if (message.type === "selfCheck") return { results: selfCheck || [] };
      if (message.type === "setWatches") return { ok: true, watches: message.watches };
      if (message.type === "clearAlerts") return { ok: true, removed: 1 };
      if (message.type === "setDealStatus") return { ok: true };
      if (message.type === "scan") return { ok: true, summary: { comparables: 5 } };
      if (message.type === "setFavourite") {
        worker.state = {
          ...worker.state,
          alerts: worker.state.alerts.map((alert) =>
            alert.key === message.key ? { ...alert, favourite: message.favourite } : alert,
          ),
        };
        return { ok: true };
      }
      if (message.type === "setCatalog") return { ok: true, catalog: message.catalog };
      if (message.type === "setSource") {
        // The real worker stores the patch and re-reports the whole registry; this
        // fake does the same thing to the source it was told about.
        const patch = message.patch || {};
        worker.state = {
          ...worker.state,
          sources: (worker.state.sources || []).map((source) =>
            source.id === message.marketplace
              ? {
                  ...source,
                  ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
                  settings: { ...source.settings, ...patch },
                }
              : source,
          ),
        };
        return { ok: true, sources: {} };
      }
      if (message.type === "setSettings") return { ok: true, settings: { ...worker.state.settings, ...message.settings } };
      if (message.type === "scanOpportunities") return { ok: true, summary: { products: 2, requests: 40 } };
      return { ok: true };
    },
    state,
  };

  const win = dom.window;
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.localStorage = win.localStorage;
  globalThis.HTMLElement = win.HTMLElement;
  // The real worker wraps every reply (src/core/messages.js); so does this fake, so
  // the dashboard is tested against the contract it will actually see.
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        try {
          return ok(await worker.handle(message));
        } catch (err) {
          return fail(err);
        }
      },
    },
  };
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0; // the 5s refresh loop would keep node alive

  // Cache-bust so every test gets its own module instance and its own boot().
  await import(`../src/dashboard.js?case=${(caseId += 1)}`);
  await settle();
  globalThis.setInterval = realSetInterval;
  return { dom, sent, worker, doc: win.document };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0)).then(() => new Promise((r) => setTimeout(r, 0)));
const text = (doc, selector) => doc.querySelector(selector)?.textContent.trim();

test("the dashboard boots, states the situation and renders a card per deal", async () => {
  const { doc } = await open();
  assert.match(text(doc, "#pill-scan"), /last scan (just now|1 min ago)/);
  assert.match(text(doc, "#pill-next"), /^next scan: in 10 min$/);
  assert.equal(text(doc, "#pill-counts"), "1 new · 1 watch(es)");

  const card = doc.querySelector(".card");
  assert.equal(card.querySelector(".title").textContent, "pixel 8 - listing 1000");
  assert.equal(card.querySelector(".headline").textContent, "110.00 EUR · 45% under 200.00 EUR market");
  assert.equal(card.querySelector(".chip-deal").textContent, "45% under");
  assert.equal(card.querySelector(".chip-watch").textContent, "pixel");
  assert.equal(card.querySelector(".chip-market").textContent, "offline demo");
  assert.equal(card.querySelector(".detail").textContent, "Google · 128 Go · Bon état");
  assert.equal(card.querySelector("img").getAttribute("src"), "https://example.invalid/1000.jpg");
  assert.equal(card.querySelector("a.open").getAttribute("href"), "https://example.invalid/items/1000");
});

test("marking a deal bought tells the worker and takes it off the New tab", async () => {
  const state = baseState();
  const { doc, sent } = await open({
    state,
    onMessage(message, worker) {
      if (message.type === "setDealStatus") {
        worker.state = baseState({ alerts: [deal({ status: "bought" })] });
      }
    },
  });
  assert.equal(doc.querySelectorAll(".card").length, 1);

  doc.querySelector(".act-bought").click();
  await settle();

  assert.deepEqual(sent.find((m) => m.type === "setDealStatus"), { type: "setDealStatus", key: "pixel|mock|1000", status: "bought" });
  assert.equal(doc.querySelectorAll(".card").length, 0, "a bought deal leaves the New tab");
  assert.match(text(doc, "#pill-counts"), /^0 new/);

  doc.querySelector('.tab[data-status="bought"]').click();
  assert.equal(doc.querySelectorAll(".card").length, 1);
  assert.equal(text(doc, ".chip-status"), "bought");
});

test("what the user typed is what gets saved, and a bad form says why", async () => {
  const { doc, sent } = await open({
    onMessage(message, worker) {
      // The real worker stores what it is given; the editor re-renders from state.
      if (message.type === "setWatches") worker.state = { ...worker.state, watches: message.watches };
    },
  });
  // The editor is re-rendered after a save, so always read the live inputs.
  const fieldIn = (name) => [...doc.querySelectorAll("details.watch [data-field]")].find((n) => n.dataset.field === name);

  fieldIn("minDiscount").value = "55";
  doc.querySelector("#save-watches").click();
  await settle();
  const saved = sent.filter((m) => m.type === "setWatches").at(-1);
  assert.equal(saved.watches[0].minDiscount, 0.55);
  assert.equal(fieldIn("minDiscount").value, "55", "the saved value is what the editor shows");

  fieldIn("name").value = "";
  doc.querySelector("#save-watches").click();
  await settle();
  assert.match(text(doc, "#watches-error"), /has no name/);
  assert.equal(sent.filter((m) => m.type === "setWatches").length, 1, "an invalid form is not sent");

  fieldIn("name").value = "vetements";
  fieldIn("searchText").value = "nike tech";
  doc.querySelector("#save-watches").click();
  await settle();
  const last = sent.filter((m) => m.type === "setWatches").at(-1);
  assert.equal(last.watches[0].name, "vetements");
  assert.equal(last.watches[0].searchText, "nike tech");
  assert.equal(doc.querySelector("#watches-error").hidden, true);
});

test("the markets and self-check panels say what actually happened", async () => {
  const { doc } = await open({
    selfCheck: [
      { marketplace: "vinted", ok: true, detail: "5 listing(s) received in 780 ms, currency EUR" },
      {
        marketplace: "leboncoin",
        ok: false,
        detail: "MarketplaceBlocked: leboncoin refused the request (anti-bot challenge)",
        advice: "Browse this marketplace in a normal tab first (so the browser holds a real session), then try again.",
      },
    ],
  });
  assert.match(text(doc, ".markets .market-line"), /200.00 EUR from 63 comparable listings/);
  assert.match(text(doc, ".markets .market"), /median 200.00 EUR · spread 25.00 EUR/);
  assert.match(text(doc, ".markets .market"), /z ≤ -1/);

  const checks = [...doc.querySelectorAll("#checks .check")];
  assert.equal(checks.length, 2);
  assert.match(checks[0].textContent, /OK · Vinted/);
  assert.match(checks[1].textContent, /FAILED · leboncoin/);
  assert.match(checks[1].textContent, /Browse this marketplace in a normal tab/);
  assert.match(doc.querySelector("#log li").textContent, /saved 1 watch\(es\)/);
});

test("an unacknowledged marketplace is a banner, not a silent failure", async () => {
  const state = baseState({
    watches: [{ ...baseState().watches[0], name: "phone", marketplace: "vinted", acknowledgeTerms: false }],
  });
  const { doc } = await open({ state });
  assert.match(text(doc, "#banner"), /phone: Vinted has no public search API/);
  // and the watch card offers the acknowledgement checkbox
  assert.match(doc.querySelector("details.watch").textContent, /I accept the terms/);
});

test("a blocked marketplace in the last run is explained, with what to do", async () => {
  const state = baseState({
    runs: { pixel: { at: new Date().toISOString(), error: "blocked", marketplace: "leboncoin", message: "anti-bot challenge" } },
  });
  const { doc } = await open({ state });
  assert.match(text(doc, "#banner"), /leboncoin refused a scan/);
  assert.match(text(doc, "#banner"), /Open that marketplace in a normal tab/);
});

test("no watches yet reads as an invitation, not an error", async () => {
  const { doc } = await open({ state: baseState({ watches: [], alerts: [], runs: {}, baselines: {} }) });
  assert.match(text(doc, "#deals-empty"), /add one on the right/);
  assert.match(text(doc, "#watches-hint"), /A watch is one product you want/);
  assert.equal(doc.querySelectorAll(".card").length, 0);
});

test("Scan now reports what it found, and the copy button survives a refusing clipboard", async () => {
  const state = baseState();
  const { doc, sent } = await open({
    state,
    onMessage(message, worker) {
      if (message.type === "scan") worker.state = baseState({ alerts: [deal(), deal({ key: "pixel|mock|1001", itemId: "1001" })] });
    },
  });
  Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => { throw new Error("denied"); } } }, configurable: true });

  doc.querySelector(".act-copy").click();
  await settle();
  assert.match(text(doc, ".act-copy"), /copy failed/);

  doc.querySelector("#scan").click();
  await settle();
  assert.ok(sent.some((m) => m.type === "scan" && m.force === true));
  assert.match(text(doc, "#banner"), /1 new deal\(s\) under the market price/);
  assert.equal(doc.querySelectorAll(".card").length, 2);
  assert.equal(doc.querySelector("#scan").disabled, false, "the button comes back");
});

test("the periodic refresh never throws away what is being typed", async () => {
  // The bug this pins down: every 5 s the dashboard re-read the worker's state and
  // rebuilt the watch editor from it, so half-typed text and just-ticked checkboxes
  // were reverted mid-edit. Ticking "I accept the terms" unticked itself the moment
  // the next poll landed.
  const state = baseState({
    watches: [{ ...baseState().watches[0], marketplace: "vinted", acknowledgeTerms: false }],
  });
  const { doc } = await open({
    state,
    onMessage(message, worker) {
      if (message.type === "setWatches") worker.state = { ...worker.state, watches: message.watches };
    },
  });
  const fieldIn = (name) => [...doc.querySelectorAll("details.watch [data-field]")].find((n) => n.dataset.field === name);

  const ack = fieldIn("acknowledgeTerms");
  const search = fieldIn("searchText");
  ack.checked = true;
  ack.dispatchEvent(new (doc.defaultView.Event)("change", { bubbles: true }));
  search.value = "iphone 13 256";
  search.dispatchEvent(new (doc.defaultView.Event)("input", { bubbles: true }));

  // Any action that talks to the worker ends in a refresh() -> render(), which used
  // to rebuild the editor from the (unchanged) stored watch.
  doc.querySelector(".act-bought").click();
  await settle();
  doc.querySelector("#clear-deals").click();
  await settle();

  assert.equal(fieldIn("acknowledgeTerms").checked, true, "a ticked checkbox survives a refresh");
  assert.equal(fieldIn("searchText").value, "iphone 13 256", "typed text survives a refresh");
  assert.equal(fieldIn("searchText"), search, "the editor is not rebuilt under the user");
  assert.equal(ack.isConnected, true, "and the checkbox the user just ticked is still the same node");

  // Saving still rebuilds from what the worker stored: that is the point of saving.
  doc.querySelector("#save-watches").click();
  await settle();
  assert.notEqual(fieldIn("searchText"), search, "a save re-renders the editor from the stored watch");
  assert.equal(fieldIn("searchText").value, "iphone 13 256");
});

test("an unsaved new watch is not wiped by the next poll either", async () => {
  const { doc } = await open();
  doc.querySelector("#add-watch").click();
  await settle();
  const before = doc.querySelectorAll("details.watch").length;
  doc.querySelector(".act-bought").click();
  await settle();
  assert.equal(doc.querySelectorAll("details.watch").length, before, "the blank editor is still there");
});

test("a deal can be starred, and the Starred tab keeps it whatever its status", async () => {
  const { doc, sent } = await open();
  doc.querySelector(".act-star").click();
  await settle();
  assert.deepEqual(sent.find((m) => m.type === "setFavourite"), { type: "setFavourite", key: "pixel|mock|1000", favourite: true });
  assert.match(text(doc, ".act-star"), /★ Starred/);
  assert.match(text(doc, ".chip-star"), /★/);

  doc.querySelector(".tab[data-favourites]").click();
  assert.equal(doc.querySelectorAll(".card").length, 1);
  assert.equal(doc.querySelector(".card").classList.contains("is-favourite"), true);
});

test("the page navigation swaps the panels, and the badges count what they say", async () => {
  const { doc } = await open();
  assert.equal(doc.querySelector("#page-deals").hidden, false);
  assert.equal(doc.querySelector("#page-opportunities").hidden, true);
  assert.equal(text(doc, "#badge-deals"), "1");
  assert.equal(text(doc, "#badge-opportunities"), "1"); // one verdict of "buy"

  doc.querySelector('.pagenav-tab[data-page="history"]').click();
  assert.equal(doc.querySelector("#page-history").hidden, false);
  assert.equal(doc.querySelector("#page-deals").hidden, true);
  assert.equal(text(doc, "#crumb"), "History", "the sticky header names the tool you are in");
  doc.querySelector('.pagenav-tab[data-page="settings"]').click();
  assert.equal(doc.querySelector("#page-settings").hidden, false);
  assert.equal(text(doc, "#crumb"), "Settings");
});

test("the opportunities page shows the trade, the confidence and the reasons", async () => {
  const { doc, sent } = await open();
  doc.querySelector('.pagenav-tab[data-page="opportunities"]').click();

  const card = doc.querySelector("#opportunities .opp");
  assert.equal(card.querySelector(".opp-name").textContent, "iPhone 13 (128 / 256 Go)");
  assert.equal(card.querySelector(".chip-verdict").textContent, "buy");
  assert.equal(card.querySelector(".chip-confidence").textContent, "high confidence");
  assert.match(card.querySelector(".opp-headline").textContent, /buy 180\.00 EUR → sell 310\.00 EUR/);
  assert.match(card.querySelector(".opp-meta").textContent, /score 70\/100 · demand 60\/100 · trend 80\/100/);
  assert.equal(card.querySelectorAll(".opp-reasons li").length, 2);
  assert.equal(card.querySelector("a.opp-buy").getAttribute("href"), "https://example.invalid/iphone-13");
  assert.match(text(doc, "#opportunity-notes"), /No eBay keyset yet|I accept the terms/, "the page states what is missing");

  // The verdict filter is a real filter: "skip" shows the other row only.
  doc.querySelector("#filter-verdict").value = "skip";
  doc.querySelector("#filter-verdict").dispatchEvent(new (doc.defaultView.Event)("input", { bubbles: true }));
  assert.equal(doc.querySelectorAll("#opportunities .opp").length, 1);
  assert.equal(doc.querySelector("#opportunities .opp .opp-name").textContent, "RTX 3060");

  doc.querySelector("#scan-opportunities").click();
  await settle();
  assert.ok(sent.some((m) => m.type === "scanOpportunities"));
  assert.match(text(doc, "#banner"), /opportunities: 2 product\(s\) measured/);
});

test("the catalogue is editable, and a bad entry is shown rather than swallowed", async () => {
  const { doc, sent } = await open({
    onMessage(message, worker) {
      if (message.type === "setCatalog" && message.catalog[0].keyword === "") throw new Error("catalogue 'iPhone 13 (128 / 256 Go)' has no keyword");
      void worker;
    },
  });
  doc.querySelector('.pagenav-tab[data-page="opportunities"]').click();
  assert.equal(doc.querySelectorAll("#catalog .catalog-row").length, 1);
  const keyword = doc.querySelector('#catalog [data-field="keyword"]');
  assert.equal(keyword.value, "iphone 13 128");

  keyword.value = "";
  keyword.dispatchEvent(new (doc.defaultView.Event)("input", { bubbles: true }));
  doc.querySelector("#save-catalog").click();
  await settle();
  assert.match(text(doc, "#catalog-error"), /has no keyword/);

  doc.querySelector('#catalog [data-field="keyword"]').value = "iphone 13 256";
  doc.querySelector("#save-catalog").click();
  await settle();
  assert.equal(text(doc, "#catalog-error"), "");
  assert.equal(sent.filter((m) => m.type === "setCatalog").at(-1).catalog[0].keyword, "iphone 13 256");
});

test("the history page lists both kinds of run, with a price line per watch", async () => {
  const { doc } = await open();
  doc.querySelector('.pagenav-tab[data-page="history"]').click();
  const rows = [...doc.querySelectorAll("#history-body tr")];
  assert.equal(rows.length, 3);
  assert.match(rows[0].textContent, /offline demo/);
  assert.match(rows[0].textContent, /200\.00 EUR from 63 comparable\(s\)/);
  assert.match(rows[2].textContent, /opportunities/);
  assert.match(rows[2].textContent, /2 product\(s\) measured/);

  assert.match(text(doc, "#sparklines"), /2 scan\(s\)/);
  assert.equal(doc.querySelector("#sparklines svg") !== null, true, "two scans are enough to draw a line");

  doc.querySelector("#filter-history-kind").value = "opportunities";
  doc.querySelector("#filter-history-kind").dispatchEvent(new (doc.defaultView.Event)("input", { bubbles: true }));
  assert.equal(doc.querySelectorAll("#history-body tr").length, 1);
});

test("settings are presented with their real values and saved as numbers and fractions", async () => {
  const { doc, sent } = await open();
  doc.querySelector('.pagenav-tab[data-page="settings"]').click();
  const input = (key) => doc.querySelector(`#settings-form [data-key="${key}"]`);
  assert.equal(input("intervalMinutes").value, "15");
  assert.equal(input("leboncoinTransport").value, "auto");
  assert.equal(input("notifications").checked, true);

  input("opportunityMinMargin").value = "25";
  input("intervalMinutes").value = "7";
  input("trendGdelt").checked = true;
  input("socialKeywords").value = "iphone 13, retro consoles";
  doc.querySelector("#save-settings").click();
  await settle();

  const patch = sent.filter((m) => m.type === "setSettings").at(-1).settings;
  assert.equal(patch.opportunityMinMargin, 0.25, "a percentage is stored as a fraction");
  assert.equal(patch.intervalMinutes, 7);
  assert.equal(patch.trendSources.gdelt, true);
  assert.equal(patch.trendSources.wikipedia, true, "the unticked sibling is preserved");
  assert.deepEqual(patch.socialKeywords, ["iphone 13", "retro consoles"]);
  assert.match(text(doc, "#banner"), /settings saved/);
});

test("a worker-side failure is shown, not swallowed", async () => {
  const { doc } = await open({
    onMessage(message) {
      if (message.type === "setWatches") throw new Error("duplicate watch name: phone");
    },
  });
  doc.querySelector("#save-watches").click();
  await settle();
  assert.match(text(doc, "#watches-error"), /duplicate watch name: phone/);
});

test("if state cannot be read at all, the dashboard says so instead of looking empty", async () => {
  const { doc } = await open({
    onMessage(message) {
      if (message.type === "getState") throw new Error("worker is unreachable");
    },
  });
  assert.match(text(doc, "#banner"), /could not read state: worker is unreachable/);
});

test("clear deals empties the badge and says how much went", async () => {
  const { doc, sent } = await open();
  doc.querySelector("#clear-deals").click();
  await settle();
  assert.ok(sent.some((m) => m.type === "clearAlerts"));
  assert.match(text(doc, "#banner"), /removed 1 stored deal/);
});

// --- the sources page -------------------------------------------------------

test("the sources page lists every source the engine has, with its real status", async () => {
  const { doc } = await open();
  doc.querySelector('[data-page="sources"]').click();
  await settle();

  assert.equal(doc.querySelector("#page-sources").hidden, false);
  assert.equal(doc.querySelector("#page-deals").hidden, true);

  const rows = [...doc.querySelectorAll("#sources-list .source-row")];
  assert.equal(rows.length, 3, "one row per source from the worker");
  assert.deepEqual(rows.map((row) => row.dataset.source), ["vinted", "ebay", "facebook"]);

  const vinted = rows[0];
  assert.match(vinted.querySelector(".source-label").textContent, /Vinted/);
  assert.match(vinted.querySelector(".chip-access").textContent, /page/);
  assert.match(vinted.querySelector(".source-status").textContent, /ready \(your tab\)/);
  assert.equal(vinted.querySelector('[data-field="enabled"]').checked, true);
  // A page source can be pointed at a URL template, and the row shows the hint.
  assert.equal(vinted.querySelector(".source-open").href, "https://www.vinted.fr/catalog?search_text=iphone%2013");

  const ebay = rows[1];
  assert.match(ebay.querySelector(".chip-access").textContent, /documented API/);
  assert.match(ebay.querySelector(".source-status").textContent, /needs credentials/);
  assert.equal(ebay.querySelector(".check-terms").hidden, true, "a documented API needs no acknowledgement");

  const facebook = rows[2];
  assert.equal(facebook.querySelector('[data-field="enabled"]').checked, false, "off by default, and shown as off");
  assert.equal(facebook.querySelector(".check-terms").hidden, false, "a prohibited source keeps its acknowledgement box");

  // The badge counts only what is switched on and not usable yet.
  assert.equal(doc.querySelector("#badge-sources").textContent, "1");
  assert.match(text(doc, "#sources-hint"), /3 source\(s\) known, 2 switched on/);
});

test("switching a source off sends the patch the worker stores", async () => {
  const { doc, sent } = await open();
  doc.querySelector('[data-page="sources"]').click();
  await settle();

  const toggle = doc.querySelector('.source-row[data-source="vinted"] [data-field="enabled"]');
  toggle.checked = false;
  toggle.dispatchEvent(new doc.defaultView.Event("change"));
  await settle();

  const patch = sent.filter((m) => m.type === "setSource").at(-1);
  assert.deepEqual(patch, { type: "setSource", marketplace: "vinted", patch: { enabled: false } });
  assert.equal(doc.querySelector('.source-row[data-source="vinted"] [data-field="enabled"]').checked, false);
});

test("a URL template typed into a source row is saved, and survives the refresh", async () => {
  const { doc, sent } = await open();
  doc.querySelector('[data-page="sources"]').click();
  await settle();

  const input = doc.querySelector('.source-row[data-source="facebook"] [data-field="urlTemplate"]');
  input.value = "https://www.facebook.com/marketplace/search/?query={query}";
  input.dispatchEvent(new doc.defaultView.Event("change"));
  await settle();

  const patch = sent.filter((m) => m.type === "setSource").at(-1);
  assert.equal(patch.marketplace, "facebook");
  assert.equal(patch.patch.urlTemplate, "https://www.facebook.com/marketplace/search/?query={query}");

  // The 5-second poll must not wipe what is in the box.
  const again = doc.querySelector('.source-row[data-source="facebook"] [data-field="urlTemplate"]');
  again.value = "https://www.facebook.com/marketplace/search/?query={query}&exact=false";
  again.dispatchEvent(new doc.defaultView.Event("input"));
  await settle();
  assert.match(doc.querySelector('.source-row[data-source="facebook"] [data-field="urlTemplate"]').value, /exact=false/);
});

test("testing one source asks the worker about that source only, and shows the answer", async () => {
  const { doc, sent } = await open({
    selfCheck: [{ marketplace: "vinted", label: "Vinted", ok: true, detail: "5 listing(s) received in 780 ms · via your open tab" }],
  });
  doc.querySelector('[data-page="sources"]').click();
  await settle();

  doc.querySelector('.source-row[data-source="vinted"] .source-test').click();
  await settle();
  await settle();

  const message = sent.filter((m) => m.type === "selfCheck").at(-1);
  assert.deepEqual(message, { type: "selfCheck", marketplace: "vinted" });
  assert.match(doc.querySelector('.source-row[data-source="vinted"] .source-check').textContent, /OK · 5 listing\(s\) received/);
  assert.match(doc.querySelector('.source-row[data-source="vinted"] .source-check').className, /is-ok/);
});

test("the providers panel shows what each provider is, and that it still needs a key", async () => {
  const { doc } = await open();
  doc.querySelector('[data-page="sources"]').click();
  await settle();

  const row = doc.querySelector("#providers-list .provider-row");
  assert.match(row.querySelector(".provider-label").textContent, /Apify/);
  assert.match(row.querySelector(".provider-status").textContent, /needs a key/);
  assert.match(row.querySelector(".provider-status").className, /is-warn/);
  assert.match(row.querySelector(".provider-what").textContent, /scrapers in its store/);
  assert.match(row.querySelector(".provider-legal").textContent, /not an authorisation layer/);
  assert.match(row.querySelector(".provider-meta").textContent, /covers: vinted, leboncoin/);
  assert.equal(row.querySelector(".provider-docs").href, "https://docs.apify.com/api/v2");
  assert.equal(row.querySelector(".provider-signup").href, "https://console.apify.com/sign-up");

  doc.querySelector("#go-to-settings").click();
  await settle();
  assert.equal(doc.querySelector("#page-settings").hidden, false);
});

test("the settings page carries every provider key, so a key never needs to be pasted into code", async () => {
  const { doc } = await open();
  doc.querySelector('[data-page="settings"]').click();
  await settle();
  const keys = [...doc.querySelectorAll("#settings-form [data-key]")].map((node) => node.dataset.key);
  for (const key of ["apifyToken", "serpApiKey", "brightDataToken", "brightDataZone", "keepaKey", "ebayClientId", "googleShoppingResale", "useApifyFallback"]) {
    assert.ok(keys.includes(key), `settings should offer ${key}`);
  }
  // And a provider key is a password field, never a plain text box.
  const apify = doc.querySelector('#settings-form [data-key="apifyToken"]');
  assert.equal(apify.type, "password");
});

// --- what the reference cards say, and what their buttons do ---------------

test("a product priced against one resale source still states its reference, and its buttons lead somewhere", async () => {
  const { doc } = await open();
  doc.querySelector('[data-page="opportunities"]').click();
  await settle();

  const card = doc.querySelector("#opportunities .opp");
  const reference = card.querySelector(".reference");
  assert.equal(reference.classList.contains("is-none"), false, "a measured reference must not be marked missing");
  // The engine only fills `resaleReferences` when several sources are compared, so
  // the common single-source case is the one that used to render nothing at all.
  assert.match(reference.querySelector(".reference-value").textContent, /310\.00 EUR — median on Back Market/);
  assert.match(reference.querySelector(".reference-samples").textContent, /9 resale listing\(s\) used · high confidence/);

  // This run stored no resaleUrl, so the button has to fall back to a real search
  // rather than staying hidden (which is what it used to do).
  const resale = card.querySelector("a.opp-resale");
  assert.equal(resale.hidden, false);
  assert.equal(resale.getAttribute("href"), "https://www.ebay.fr/sch/i.html?_nkw=iphone%2013%20256");
  assert.match(resale.textContent, /Search the resale side/);
  assert.equal(card.querySelector("a.opp-buy").getAttribute("href"), "https://example.invalid/iphone-13");
});

test("a product with no resale price says so, instead of showing an empty reference", async () => {
  const { doc } = await open({
    state: baseState({
      opportunities: [opportunity({ resalePrice: null, resaleSample: 0, resaleUrl: null, buyUrl: null })],
    }),
  });
  doc.querySelector('[data-page="opportunities"]').click();
  await settle();

  const card = doc.querySelector("#opportunities .opp");
  assert.equal(card.querySelector(".reference").classList.contains("is-none"), true);
  assert.match(card.querySelector(".reference-value").textContent, /no resale price measured/);
  assert.match(card.querySelector(".reference-samples").textContent, /add an eBay keyset in API keys/);

  // No stored buy URL, but vinted publishes a search URL: a working link, not a
  // button that swallows the click.
  assert.match(card.querySelector("a.opp-buy").getAttribute("href"), /vinted\.fr\/catalog\?search_text=/);
  assert.match(card.querySelector("a.opp-resale").getAttribute("href"), /ebay\.fr\/sch\/i\.html/);
});

test("a card with nowhere to point hides the button rather than faking one", async () => {
  const { doc } = await open({
    state: baseState({ opportunities: [opportunity({ buyUrl: null, buyMarket: ["nowhere"], resaleUrl: null, resaleSource: "unknown-shop" })] }),
  });
  doc.querySelector('[data-page="opportunities"]').click();
  await settle();
  const card = doc.querySelector("#opportunities .opp");
  assert.equal(card.querySelector("a.opp-buy").hidden, true);
  assert.equal(card.querySelector("a.opp-resale").hidden, false, "eBay is always a usable fallback resale search");
});

test("Track as a watch turns a scored product into a real watch, and lands you on Deals", async () => {
  const onMessage = (message, worker) => {
    // The real worker stores what it is given and re-reports it; this fake stores it
    // too, so the assertion below is about the message and not about the echo.
    if (message.type === "setWatches") worker.state = { ...worker.state, watches: message.watches };
  };
  const { doc, sent } = await open({ onMessage });
  doc.querySelector('[data-page="opportunities"]').click();
  await settle();

  const card = doc.querySelector("#opportunities .opp");
  assert.equal(card.querySelector(".opp-watch").textContent, "Track as a watch");
  card.querySelector(".opp-watch").click();
  await settle();
  await settle();

  const saved = sent.filter((m) => m.type === "setWatches").at(-1);
  assert.ok(saved, "the button must tell the worker about the new watch");
  const added = saved.watches.find((watch) => watch.name === "iPhone 13 (128 / 256 Go) (opp)");
  assert.ok(added, `expected the product to become a watch, got ${saved.watches.map((w) => w.name).join(", ")}`);
  assert.equal(added.searchText, "iphone 13 256", "the catalogue keyword becomes the search text");
  assert.equal(added.marketplace, "vinted", "it watches the buy side");
  assert.equal(added.exactPhrase, true);
  assert.ok(added.plausibleMinPrice > 0 && added.plausibleMaxPrice > added.plausibleMinPrice, "with a price band, not 0..0");
  assert.ok(saved.watches.length > 1, "and the watches already there are kept");

  assert.equal(doc.querySelector("#page-deals").hidden, false, "you end up where the watch will report");
  assert.match(text(doc, "#banner"), /added "iPhone 13 \(128 \/ 256 Go\) \(opp\)" as a watch/);

  // Asking twice must not create a duplicate.
  doc.querySelector('[data-page="opportunities"]').click();
  await settle();
  const before = sent.filter((m) => m.type === "setWatches").length;
  doc.querySelector("#opportunities .opp .opp-watch").click();
  await settle();
  assert.equal(sent.filter((m) => m.type === "setWatches").length, before, "a watch that already exists is not sent again");
  assert.match(text(doc, "#banner"), /is already a watch/);
});

test("How this is measured opens the explanation rather than doing nothing", async () => {
  const { doc } = await open();
  doc.querySelector('[data-page="opportunities"]').click();
  await settle();
  const panel = doc.querySelector("#opportunity-explanation");
  panel.open = false;
  doc.querySelector("#opportunities-help").click();
  assert.equal(panel.open, true);
  assert.match(panel.querySelector("summary").textContent, /What this page actually measures/);
});

// --- the API keys page ------------------------------------------------------

test("the API keys page explains, step by step, how to wire up each provider", async () => {
  const { doc } = await open();
  doc.querySelector('[data-page="providers"]').click();
  await settle();
  assert.equal(doc.querySelector("#page-providers").hidden, false);

  const cards = [...doc.querySelectorAll("#api-setup .setup-card")];
  assert.deepEqual(
    cards.map((card) => card.querySelector(".setup-label").textContent),
    ["eBay developer keyset", "Apify"],
    "eBay first (the key the extension expects), then the providers from the registry",
  );

  const apify = cards[1];
  assert.match(apify.querySelector(".setup-lead").textContent, /Covers: vinted, leboncoin/);
  assert.ok(apify.querySelectorAll(".setup-steps li").length >= 5, "the steps should cover signup, paste and the switch");
  const steps = apify.querySelector(".setup-steps").textContent;
  assert.match(steps, /API & Integrations/, "where in Apify's dashboard the token lives");
  assert.match(steps, /Apify API token/, "which settings field takes it");
  assert.match(steps, /fall back to an Apify actor/, "and which switch actually spends the key");
  assert.match(steps, /Test every enabled source/, "and how to prove it works");
  assert.match(apify.querySelector(".setup-keys").textContent, /apifyToken → Settings → "Apify API token"/);
  assert.equal(apify.querySelector(".provider-signup").href, "https://console.apify.com/sign-up");
  assert.match(apify.querySelector(".setup-legal").textContent, /sent only to Apify/);

  // The eBay card is the one that must name its own keys and say what is missing.
  const ebay = cards[0];
  assert.match(ebay.querySelector(".setup-keys").textContent, /ebayClientId → Settings → "eBay Client ID"/);
  assert.match(ebay.querySelector(".setup-keys").textContent, /missing right now: ebayClientId, ebayClientSecret/);
  assert.equal(ebay.querySelector(".provider-docs").href, "https://developer.ebay.com/signin");
  assert.match(ebay.querySelector(".setup-status").textContent, /needs a key/);

  // "Where do I paste it?" goes straight to the form that has the field.
  apify.querySelector(".setup-settings").click();
  await settle();
  assert.equal(doc.querySelector("#page-settings").hidden, false);
  assert.ok(doc.querySelector('#settings-form [data-key="apifyToken"]'));
});

// --- the price check tool ---------------------------------------------------

test("the price check asks the worker for one keyword's median and shows it", async () => {
  const { doc, sent } = await open({
    onMessage(message) {
      if (message.type === "priceCheck") {
        return {
          ok: true,
          marketplace: "vinted",
          label: "Vinted",
          keyword: "iphone 13 128",
          currency: "EUR",
          stats: { median: 240, q1: 200, q3: 290, mad: 35, usedSize: 40, sampleSize: 44 },
          checked: 44,
          totalEntries: 900,
          cheapest: [{ title: "iphone 13 128 - cheap", price: 180, currency: "EUR", url: "https://example.invalid/cheap" }],
          durationMs: 812,
          via: "your open tab",
        };
      }
    },
  });
  doc.querySelector('[data-page="price"]').click();
  await settle();
  assert.equal(doc.querySelector("#page-price").hidden, false);

  doc.querySelector("#price-keyword").value = "iphone 13 128";
  doc.querySelector("#price-run").click();
  await settle();

  const message = sent.filter((m) => m.type === "priceCheck").at(-1);
  assert.equal(message.marketplace, "vinted", "the marketplace dropdown is populated from the registry");
  assert.equal(message.keyword, "iphone 13 128");
  assert.equal(message.minPrice, "");

  const result = doc.querySelector("#price-result");
  assert.equal(result.hidden, false);
  assert.match(result.textContent, /240\.00 EUR/, "the median is the headline number");
  assert.match(result.textContent, /200\.00 EUR - 290\.00 EUR/, "and the middle half of the market is spelled out");
  assert.match(result.textContent, /44 listing\(s\) with a readable price/);
  assert.equal(result.querySelector("a.t").getAttribute("href"), "https://example.invalid/cheap");
});

test("a price check with no keyword, or one the worker refuses, explains itself", async () => {
  const { doc, sent } = await open({
    onMessage(message) {
      if (message.type === "priceCheck") throw new Error("type something to search for");
    },
  });
  doc.querySelector('[data-page="price"]').click();
  await settle();

  doc.querySelector("#price-run").click();
  await settle();
  assert.equal(sent.some((m) => m.type === "priceCheck"), false, "an empty box is not sent to the worker");
  assert.match(text(doc, "#price-error"), /Type what you want priced/);

  doc.querySelector("#price-keyword").value = "iphone";
  doc.querySelector("#price-run").click();
  await settle();
  assert.match(text(doc, "#price-error"), /type something to search for/);
  assert.equal(doc.querySelector("#price-result").hidden, true);
});
