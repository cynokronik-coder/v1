/**
 * A stand-in for the extension's service worker, for looking at the dashboard in a
 * normal browser tab.
 *
 * The dashboard talks to `chrome.runtime.sendMessage`; outside an extension that
 * does not exist, so this file answers the same messages from the real registries
 * (core/sources.js, core/providers.js, core/catalog.js) plus a handful of synthetic
 * deals and opportunities. That means the Marketplaces, API-keys and Settings pages
 * render the engine's actual data - a source or provider added to the registry shows
 * up here with no change to this file.
 *
 * It is a development aid: nothing here is loaded by the extension itself (see
 * tools/dashboard-preview/server.mjs, which injects this file only when serving the
 * page over HTTP).
 */

import { ok } from "/src/core/messages.js";
import { DEFAULT_CATALOG } from "/src/core/catalog.js";
import { DEFAULT_SETTINGS } from "/src/core/storage.js";
import {
  PROVIDERS,
  SOURCES,
  credentialKeysFor,
  describeSource,
  sourceConfig,
  sourceEnabled,
  sourceReady,
} from "/src/core/sources.js";

const settings = { ...DEFAULT_SETTINGS };

function sourceState() {
  return SOURCES.map((source) => {
    const described = describeSource(source.id, { settings });
    return {
      id: source.id,
      label: source.label,
      kind: source.kind,
      side: source.side,
      access: source.access,
      mode: described.mode,
      status: described.status,
      detail: described.detail,
      hosts: source.hosts,
      searchHint: source.searchHint,
      terms: source.terms,
      termsNote: source.termsNote,
      note: source.note,
      advice: source.advice,
      buying: source.buying,
      resale: source.resale,
      enabled: sourceEnabled(source.id, settings),
      credentialReady: sourceReady(source.id, settings),
      credentials: source.credentials
        ? { ...source.credentials, missing: credentialKeysFor(source.id).filter((key) => !settings[key]) }
        : null,
      settings: sourceConfig(source.id, settings),
    };
  });
}

function providerState() {
  return PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    docsUrl: provider.docsUrl,
    signupUrl: provider.signupUrl,
    freeTier: provider.freeTier,
    what: provider.what,
    legal: provider.legal,
    covers: provider.covers,
    keys: provider.keys,
    configured: provider.keys.every((entry) => Boolean(settings[entry.key])),
  }));
}

function deal(over = {}) {
  return {
    key: `preview|${over.itemId || 1000}`,
    watch: over.watch || "pixel 8",
    marketplace: over.marketplace || "mock",
    itemId: String(over.itemId || 1000),
    title: over.title || "Google Pixel 8 128 Go - très bon état",
    url: `https://example.invalid/items/${over.itemId || 1000}`,
    imageUrl: null,
    price: over.price ?? 210,
    currency: "EUR",
    marketPrice: over.marketPrice ?? 385,
    discountPct: over.discountPct ?? 0.45,
    robustZ: -3.4,
    condition: "Très bon état",
    size: "128 Go",
    brand: "Google",
    reasons: ["45% under the median", "far below the 15th percentile"],
    firstSeen: new Date().toISOString(),
    status: over.status || "new",
    favourite: Boolean(over.favourite),
  };
}

function opportunity(over = {}) {
  return {
    id: over.id || "iphone-13",
    name: over.name || "iPhone 13 (128 / 256 Go)",
    category: over.category || "phones",
    keyword: over.keyword || "iphone 13 128",
    buyMarket: over.buyMarket || ["vinted", "leboncoin"],
    resaleSource: over.resaleSource || "backmarket",
    buyPrice: over.buyPrice ?? 180,
    resalePrice: over.resalePrice === undefined ? 310 : over.resalePrice,
    resaleReferences: over.resaleReferences || [],
    resaleSpread: 0.08,
    manualResalePrice: over.manualResalePrice ?? null,
    profitAbs: 84.4,
    marginPct: over.marginPct ?? 0.47,
    spreadPct: 0.72,
    buySample: 24,
    resaleSample: over.resaleSample ?? 9,
    buyUrl: over.buyUrl === undefined ? "https://example.invalid/iphone-13" : over.buyUrl,
    resaleUrl: over.resaleUrl || null,
    currency: "EUR",
    confidence: over.confidence || "high",
    confidenceReason: "24 buy-side and 9 resale listings",
    liquidity: 0.6,
    trend: 0.8,
    score: over.score ?? 0.7,
    verdict: over.verdict || "buy",
    reasons: [
      "buy at ~180.00 EUR (24 listing(s), 15th percentile)",
      "after 10% commission and 5.00 shipping: net 268.42 on 180.00 cost = +88.42 EUR (49.1%)",
    ],
  };
}

const state = () => ({
  watches: [
    {
      name: "pixel 8",
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
      exactPhrase: false,
      mustMatch: [],
      mustNotMatch: [],
      sizes: [],
      conditions: [],
    },
  ],
  settings,
  alerts: [
    deal({ itemId: 1000, price: 210, marketPrice: 385, discountPct: 0.45 }),
    deal({ itemId: 1042, title: "Pixel 8 Pro 256 Go (écran changé)", price: 305, marketPrice: 520, discountPct: 0.41 }),
    deal({ itemId: 1077, title: "Google Pixel 8 - boîte scellée", price: 415, marketPrice: 590, discountPct: 0.3, favourite: true }),
  ],
  runs: { "pixel 8": { at: new Date(Date.now() - 4 * 60000).toISOString(), marketPrice: 385, comparables: 61, error: null } },
  baselines: {
    "pixel 8": { stats: { median: 385, mad: 42, currency: "EUR", usedSize: 61, rawSize: 70 }, computedAt: new Date().toISOString() },
  },
  history: [
    { at: new Date(Date.now() - 4 * 60000).toISOString(), kind: "watch", watch: "pixel 8", marketplace: "mock", marketPrice: 385, currency: "EUR", comparables: 61, deals: 3, newDeals: 1, requests: 3, error: null, message: null },
    { at: new Date(Date.now() - 30 * 60000).toISOString(), kind: "watch", watch: "pixel 8", marketplace: "mock", marketPrice: 372, currency: "EUR", comparables: 44, deals: 2, newDeals: 0, requests: 3, error: null, message: null },
    { at: new Date(Date.now() - 90 * 60000).toISOString(), kind: "opportunities", watch: null, products: 12, deals: 1, newDeals: 0, requests: 96, error: null, message: null },
  ],
  catalog: DEFAULT_CATALOG,
  opportunities: [
    opportunity(),
    opportunity({
      id: "rtx-3060",
      name: "RTX 3060 12 Go",
      category: "pc-parts",
      keyword: "rtx 3060 12gb",
      buyMarket: ["leboncoin"],
      resaleSource: "ebay",
      buyPrice: 148,
      resalePrice: 205,
      resaleSample: 14,
      marginPct: 0.19,
      score: 0.52,
      verdict: "watch",
      confidence: "medium",
      buyUrl: null,
      resaleUrl: "https://example.invalid/rtx-3060-counter",
    }),
    opportunity({
      id: "rx-6800",
      name: "Radeon RX 6800",
      category: "pc-parts",
      keyword: "rx 6800",
      buyMarket: ["vinted"],
      resaleSource: "ebay",
      buyPrice: 300,
      resalePrice: null,
      resaleSample: 0,
      marginPct: -0.02,
      score: 0.2,
      verdict: "skip",
      confidence: "low",
      buyUrl: null,
      resaleUrl: null,
    }),
  ],
  opportunityRuns: [
    { at: new Date(Date.now() - 90 * 60000).toISOString(), products: 12, requests: 96, verdicts: { buy: 1, watch: 1, skip: 1 }, errors: [] },
  ],
  tabs: { vinted: true, leboncoin: true, ebay: false },
  log: [
    { level: "info", at: new Date(Date.now() - 4 * 60000).toISOString(), message: "scan: 3 new deal(s)" },
    { level: "warn", at: new Date(Date.now() - 30 * 60000).toISOString(), message: "ebay: needs credentials" },
    { level: "info", at: new Date(Date.now() - 90 * 60000).toISOString(), message: "opportunities: 12 product(s) measured" },
  ],
  unofficialMarketplaces: ["vinted", "leboncoin", "backmarket"],
  sources: sourceState(),
  providers: providerState(),
  nextRunAt: Date.now() + 11 * 60000,
  nextOpportunityRunAt: Date.now() + 6 * 3600000,
  scanning: false,
  opportunityScanning: false,
});

function selfCheckResults() {
  return [
    { marketplace: "mock", label: "Offline demo", ok: true, detail: "12 listing(s) received in 3 ms · deterministic fixture" },
    { marketplace: "vinted", label: "Vinted", ok: true, detail: "5 listing(s) received in 780 ms · via your open tab" },
    {
      marketplace: "ebay",
      label: "eBay (Browse API)",
      ok: false,
      detail: "missing credentials",
      advice: "Paste your Client ID and Client Secret in Settings, then try again.",
    },
  ];
}

function priceCheck(message) {
  const keyword = String(message.keyword || "iphone 13");
  const base = keyword.toLowerCase().includes("pixel") ? 385 : keyword.toLowerCase().includes("3060") ? 205 : 240;
  const cheapest = [0.52, 0.61, 0.68, 0.74, 0.81, 0.88].map((factor, index) => ({
    title: `${keyword} - listing ${index + 1}`,
    price: Math.round(base * factor),
    currency: "EUR",
    url: `https://example.invalid/price/${index + 1}`,
  }));
  return {
    ok: true,
    marketplace: message.marketplace,
    label: (SOURCES.find((source) => source.id === message.marketplace) || {}).label || message.marketplace,
    keyword,
    currency: "EUR",
    stats: { median: base, mean: base + 6, q1: Math.round(base * 0.82), q3: Math.round(base * 1.18), mad: Math.round(base * 0.09), usedSize: 44, sampleSize: 48 },
    checked: 48,
    totalEntries: 900,
    cheapest,
    durationMs: 812,
    via: "your open tab",
  };
}

window.chrome = {
  runtime: {
    getURL: (path) => `/${path}`,
    sendMessage: async (message) => {
      switch (message.type) {
        case "getState":
          return ok(state());
        case "selfCheck":
          return ok({ results: selfCheckResults() });
        case "priceCheck":
          return ok(priceCheck(message));
        case "scan":
          return ok({ ok: true, summary: { comparables: 61, deals: 3 } });
        case "scanOpportunities":
          return ok({ ok: true, summary: { products: 12, requests: 96 }, opportunities: state().opportunities });
        case "setWatches":
        case "setCatalog":
        case "setSettings":
        case "setSource":
        case "setDealStatus":
        case "setFavourite":
        case "clearAlerts":
        case "addDemoWatch":
        case "notifyTest":
          return ok({ ok: true, watches: state().watches, catalog: state().catalog, removed: 1 });
        default:
          return ok({ ok: true });
      }
    },
  },
};
