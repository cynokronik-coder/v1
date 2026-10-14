/**
 * The source registry: the file that decides which marketplaces this tool can
 * reach, how it reaches them and what it promises about their terms.
 *
 * The tests below are mostly invariants, because the registry is data: a bad entry
 * does not throw, it quietly produces a marketplace that cannot be scanned or a
 * claim that is not true.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCESS,
  BUY_SOURCES,
  MODE,
  PAGE_SOURCE_IDS,
  PROVIDERS,
  RESALE_REFERENCE_SOURCES,
  SOURCES,
  SOURCE_IDS,
  TERMS,
  UNOFFICIAL_SOURCE_IDS,
  assertKnownSource,
  credentialKeysFor,
  describeSource,
  hostFor,
  isKnownSource,
  modeFor,
  sourceById,
  providersForSource,
  providerById,
  requiredCredentialKeysFor,
  providerKeysConfigured,
  searchHintFor,
  searchUrlFor,
  sourceById as byId,
  sourceConfig,
  sourceEnabled,
  sourceReady,
  sourcesByKind,
} from "../src/core/sources.js";
import { MARKETPLACES, RESALE_SOURCES, UNOFFICIAL_MARKETPLACES } from "../src/core/models.js";

test("the registry covers ten real marketplaces, honestly labelled", () => {
  const real = SOURCES.filter((source) => source.id !== "mock");
  assert.ok(real.length >= 10, `expected ten marketplaces, found ${real.length}`);

  const ids = real.map((source) => source.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  for (const id of ["vinted", "leboncoin", "ebay", "backmarket", "easycash", "cashexpress", "cashconverters", "momox", "fnac", "cdiscount"]) {
    assert.ok(ids.includes(id), `${id} should be in the registry`);
  }

  for (const source of SOURCES) {
    assert.ok(source.label && source.kind && source.side, `${source.id} is missing a label/kind/side`);
    assert.ok(source.note.length > 20, `${source.id} needs a note worth reading`);
    assert.ok([ACCESS.API, ACCESS.PAGE].includes(source.access), `${source.id} has an unknown access mode`);
    assert.ok([MODE.API, MODE.SEARCH_URL, MODE.OPEN_TAB].includes(source.mode), `${source.id} has an unknown mode`);
    assert.ok([TERMS.DOCUMENTED, TERMS.UNOFFICIAL, TERMS.PROHIBITED].includes(source.terms), `${source.id} has no terms status`);
    assert.ok(source.pacing.minIntervalMs >= 4000, `${source.id} paces too fast to be polite`);
    for (const host of source.hosts || []) {
      assert.ok(!host.includes("://") && !host.includes("/"), `${source.id}: host '${host}' must be a bare host`);
    }
    if (source.access === ACCESS.PAGE) {
      assert.ok(source.hosts.length > 0, `${source.id} is a page source, so it needs a host to look for a tab on`);
    }
    if (source.mode === MODE.SEARCH_URL) {
      assert.match(source.searchUrl, /^https:\/\/[^ ]*\{query\}/, `${source.id} needs an https search URL template`);
    }
    if (source.terms !== TERMS.DOCUMENTED) {
      assert.ok(source.termsNote.length > 30, `${source.id} must say what its terms actually are`);
    }
    if (source.access === ACCESS.API && source.id !== "mock") {
      assert.ok(source.credentials, `${source.id} uses an API, so it needs credentials documented`);
    }
  }
});

test("the derived marketplace lists agree with the registry", () => {
  assert.deepEqual(MARKETPLACES, BUY_SOURCES);
  assert.deepEqual(RESALE_SOURCES, [...RESALE_REFERENCE_SOURCES, "manual"]);
  assert.deepEqual(Object.keys(UNOFFICIAL_MARKETPLACES), UNOFFICIAL_SOURCE_IDS);
  assert.ok(PAGE_SOURCE_IDS.length >= 8, "most of these marketplaces have no public search API");
  assert.equal(byId("ebay").access, ACCESS.API, "eBay is the documented one");
});

test("eBay is the only credentialed marketplace, and it is described accurately", () => {
  const credentialed = SOURCES.filter((source) => source.credentials);
  assert.deepEqual(credentialed.map((source) => source.id), ["ebay"]);
  assert.deepEqual(credentialKeysFor("ebay"), ["ebayClientId", "ebayClientSecret", "ebayMarketplaceId"]);
  assert.match(byId("ebay").credentials.docsUrl, /^https:\/\/developer\.ebay\.com\//);
  assert.match(byId("ebay").credentials.note, /no seller account/i);
  assert.deepEqual(credentialKeysFor("vinted"), []);
  // The marketplace id has a working default, so it is not a reason to call eBay unconfigured.
  assert.deepEqual(requiredCredentialKeysFor("ebay"), ["ebayClientId", "ebayClientSecret"]);
  assert.equal(sourceReady("ebay", { ebayClientId: "a", ebayClientSecret: "b" }), true);
});

test("ids are looked up, not assumed: aliases work and unknown ids are refused", () => {
  assert.equal(sourceById("lbc").id, "leboncoin");
  assert.equal(sourceById("back_market").id, "backmarket");
  assert.equal(sourceById("fixture").id, "mock");
  assert.equal(sourceById(" WALLAPOP "), null);
  assert.equal(isKnownSource("wallapop"), false);
  assert.equal(isKnownSource("Vinted"), true);
  assert.throws(() => assertKnownSource("wallapop"), /unknown source 'wallapop'/);
  assert.equal(hostFor("easycash"), "www.easycash.fr");
});

test("search URLs are built from the registry, and the user's template wins", () => {
  assert.equal(searchUrlFor("cdiscount", "iphone 13"), "https://www.cdiscount.com/search/10/iphone%2013.html");
  assert.equal(
    sourceConfig("cdiscount", { sources: { cdiscount: { urlTemplate: "https://x.test/q={query}" } } }).urlTemplate,
    "https://x.test/q={query}",
  );
  assert.equal(sourceConfig("vinted", {}).urlTemplate, undefined);
  assert.equal(
    searchUrlFor("cdiscount", "ps5", { sources: { cdiscount: { urlTemplate: "https://x.test/q={query}" } } }),
    "https://x.test/q=ps5",
  );
  assert.equal(searchUrlFor("easycash", "iphone"), null, "easycash has no template: it reads your tab instead");
  assert.throws(() => searchUrlFor("wallapop", "x"), /unknown source/);
  assert.match(searchHintFor("easycash", "iphone"), /^https:\/\//);
  assert.equal(searchHintFor("mock", "iphone"), null);
});

test("the mode of a source follows the registry and the user's overrides", () => {
  assert.equal(sourcesMode("easycash"), MODE.OPEN_TAB);
  assert.equal(sourcesMode("easycash", { sources: { easycash: { urlTemplate: "https://e.test/s?q={query}" } } }), MODE.SEARCH_URL);
  assert.equal(sourcesMode("easycash", { sources: { easycash: { mode: "open-tab" } } }), MODE.OPEN_TAB);
  assert.equal(sourcesMode("cdiscount", { sources: { cdiscount: { mode: "open-tab" } } }), MODE.OPEN_TAB);
  assert.equal(sourcesMode("cdiscount", { sources: { cdiscount: { mode: "auto" } } }), MODE.SEARCH_URL);
  assert.equal(sourcesMode("ebay"), MODE.API, "a documented API is never scraped");
});

test("a source can be switched off, and off means off", () => {
  assert.equal(sourceEnabled("vinted", {}), true);
  assert.equal(sourceEnabled("facebook", {}), false, "Facebook is off by default: Meta's terms forbid collection");
  assert.equal(sourceEnabled("facebook", { sources: { facebook: { enabled: true } } }), true);
  assert.equal(sourceEnabled("vinted", { sources: { vinted: { enabled: false } } }), false);
  assert.equal(sourceEnabled("wallapop", {}), false);
});

test("the registry says why a source is not usable, in the order that matters", () => {
  assert.equal(describeSource("ebay", { settings: {} }).status, "needs credentials");
  assert.match(describeSource("ebay", { settings: {} }).detail, /free developer account/i);
  assert.equal(describeSource("ebay", { settings: { ebayClientId: "a", ebayClientSecret: "b", ebayMarketplaceId: "EBAY_FR" } }).status, "ready");
  assert.equal(sourceReady("ebay", { ebayClientId: "a", ebayClientSecret: "b" }), true);

  assert.equal(describeSource("facebook", { settings: {} }).status, "off (terms)");
  assert.equal(
    describeSource("facebook", { settings: { sources: { facebook: { acknowledgeTerms: true } } }, tabOpen: false }).status,
    "needs an open tab",
  );

  const closed = describeSource("easycash", { settings: {}, tabOpen: false });
  assert.equal(closed.status, "needs an open tab");
  assert.match(closed.detail, /Open /);
  assert.equal(describeSource("easycash", { settings: {}, tabOpen: true }).status, "reads your tab");
  assert.equal(describeSource("vinted", { settings: {}, tabOpen: true }).status, "ready (your tab)");
  assert.equal(describeSource("vinted", { settings: {}, tabOpen: false }).status, "ready");
  assert.equal(describeSource("wallapop", { settings: {} }).status, "unknown");
});

test("the Sources page groups are derived from the registry, not hard-coded", () => {
  const groups = sourcesByKind();
  const listed = groups.flatMap((group) => group.ids);
  assert.deepEqual(listed.sort(), SOURCE_IDS.slice().sort());
  assert.ok(groups.some((group) => group.kind === "refurb"), "Back Market and momox are refurbishers");
});

test("the data providers are described with what they cover and what they do not", () => {
  assert.equal(PROVIDERS.length, 4);
  for (const provider of PROVIDERS) {
    assert.ok(provider.label && provider.docsUrl.startsWith("https://"), `${provider.id} needs a docs URL`);
    assert.ok(provider.keys.length > 0 && provider.legal.length > 30, `${provider.id} must state its legal position`);
    assert.ok(provider.what.length > 30, `${provider.id} must say what it returns`);
    assert.ok(provider.freeTier, `${provider.id} should mention its free tier`);
  }
  assert.deepEqual(providerKeysConfigured({ apifyToken: "x" }), { apify: true, serpapi: false, brightdata: false, keepa: false });
  assert.equal(providerById("serpapi").keySetting, "serpApiKey");
  assert.equal(providerById("nope"), null);

  // Which provider could fill in for which marketplace: only the ones that return
  // listings. Google Shopping cannot tell you what a leboncoin seller is asking.
  assert.deepEqual(providersForSource("vinted").map((provider) => provider.id), ["apify", "brightdata"]);
  assert.deepEqual(providersForSource("momox").map((provider) => provider.id), ["apify", "brightdata"]);
  assert.deepEqual(providersForSource("cdn"), [], "unknown marketplaces have no providers");
  assert.deepEqual(providersForSource("ebay"), [], "eBay has its own API: no vendor needed");
  assert.deepEqual(providersForSource("wallapop"), []);
  assert.deepEqual(providersForSource("vinted").map((p) => p.id), ["apify", "brightdata"], "not serpapi, not keepa");
});

/** modeFor, with a shorter call site for readability above. */
function sourcesMode(id, settings = {}) {
  return modeFor(id, settings);
}
