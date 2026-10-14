/**
 * Live check of the shipped adapter code against the real marketplaces, run from
 * node: same VintedAdapter/LeboncoinAdapter, same browserFetch wrapper the service
 * worker uses, real network. Not part of `npm test` (it needs the internet and it
 * talks to third parties); run it by hand with `node live-check.mjs`.
 */
import { browserFetch } from "./src/background.js";
import { VintedAdapter } from "./src/core/adapters/vinted.js";
import { LeboncoinAdapter } from "./src/core/adapters/leboncoin.js";
import { buildStats, explainNoDeals, findDeals, scoreListing } from "./src/core/analyzer.js";
import { normalizeWatch } from "./src/core/models.js";

// The browser sends the marketplace's own cookies on every request (the adapter
// asks for credentials: "include"); node has no cookie jar, so this one stands in.
const jar = new Map(); // cookie name -> value (like the browser's .vinted.fr cookies)
const raw = globalThis.fetch;
const catching = async (url, init = {}) => {
  const response = await raw(url, {
    ...init,
    headers: { ...(init.headers || {}), ...(jar.size ? { Cookie: cookieHeader() } : {}) },
  });
  for (const c of response.headers.getSetCookie?.() || []) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return response;
};
const cookies = async (_url, name) => jar.get(name) ?? null;

function cookieHeader() {
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

const waits = [];
const sleep = (ms) => (waits.push(ms), Promise.resolve());

console.log("=== VINTED (live) ===");
const vinted = new VintedAdapter({ fetchImpl: browserFetch(catching), cookies, sleep, logger: () => {} });
try {
  const result = await vinted.search({
    searchText: "iphone 13 128",
    page: 1,
    perPage: 24,
    order: "newest",
    minPrice: 100,
    maxPrice: 700,
  });
  console.log(`items=${result.items.length} total=${result.totalEntries} pages=${result.totalPages} page=${result.page}/${result.perPage}`);
  console.log(`anon_id captured: ${Boolean(jar.get("anon_id"))} · pacing waits: ${waits.length} [${waits.map((w) => Math.round(w)).join(",")}]`);
  for (const item of result.items.slice(0, 3)) {
    console.log(`  ${item.price} ${item.currency} | ${item.title.slice(0, 48)} | ${item.size || "-"} | ${item.url}`);
  }
  // Exactly what scan.js does: judge within one currency, never across.
  const counts = new Map();
  for (const item of result.items) counts.set(item.currency, (counts.get(item.currency) || 0) + 1);
  const [currency] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const pool = result.items.filter((i) => i.currency === currency);
  const stats = buildStats(pool.map((i) => i.price), currency);
  console.log(`currency ${currency} · stats:`, stats);
  // A watch exactly as the app builds it (defaults filled in by normalizeWatch).
  const watch = normalizeWatch({
    name: "live",
    marketplace: "vinted",
    searchText: "iphone 13 128",
    minDiscount: 0.3,
    maxRobustZ: null,
    minSampleSize: 8,
    plausibleMinPrice: 100,
    plausibleMaxPrice: 700,
    mustMatch: ["iphone 13"],
    mustNotMatch: ["cracked", "for parts"],
  });
  const deals = findDeals(pool, stats, watch);
  const cheapest = pool.map((listing) => scoreListing(listing, stats, watch)).filter(Boolean).sort((a, b) => a.price - b.price).slice(0, 3);
  for (const s of cheapest) {
    console.log(`  cheapest: ${s.listing.price} ${currency} (${(s.discountPct * 100).toFixed(0)}% under, z=${Number(s.robustZ).toFixed(2)}) ${s.listing.title.slice(0, 40)}`);
  }
  console.log(`deals with >=30% off and no z-gate: ${deals.length}`);
  for (const deal of deals) console.log(`  DEAL ${deal.listing.price} ${currency} | ${deal.listing.title.slice(0, 44)} | ${deal.listing.url}`);
  for (const reason of explainNoDeals(pool, stats, watch)) console.log("  no-deal note:", reason);

  // The opportunities engine on the same real sample: what would one run conclude?
  // The resale price is typed in by hand here on purpose - that is exactly what you
  // do when Back Market cannot be read and you have no eBay keyset.
  const { computeOpportunity } = await import("./src/core/opportunity.js");
  const { normalizeCatalogItem } = await import("./src/core/catalog.js");
  console.log("\n  --- opportunity engine, manual resale price = median + 35% ---");
  const manualResalePrice = Math.round(stats.median * 1.35);
  const opportunity = computeOpportunity({
    product: normalizeCatalogItem({
      id: "live",
      name: "live sample",
      keyword: "iphone 13 128",
      buyMarket: ["vinted"],
      resaleSource: "manual",
      manualResalePrice,
      plausibleMinPrice: 100,
      plausibleMaxPrice: 700,
    }),
    buyListings: pool,
    manualResalePrice,
    settings: { opportunityMinMargin: 0.15, opportunityMinConfidence: "medium" },
  });
  console.log(`  ${opportunity.verdict} · ${opportunity.confidence} confidence · margin ${opportunity.marginPct} · score ${opportunity.score}`);
  for (const reason of opportunity.reasons) console.log("   ", reason);
} catch (err) {
  console.log(`VINTED FAILED: ${err.name}: ${err.message}`);
}

console.log("\n=== PAGE SOURCES FROM THE REGISTRY (live) ===");
// Every registered page source, tried once with the real fetch. A `reads your tab`
// source cannot be tested from node (there is no tab to read), and saying so is the
// honest answer rather than a fake pass.
const { SOURCES, MODE, modeFor, searchUrlFor, hostFor } = await import("./src/core/sources.js");
const { getAdapter } = await import("./src/core/adapters/index.js");
for (const source of SOURCES) {
  if (source.access !== "page" || source.id === "leboncoin") continue;
  const settings = { sources: {} };
  const mode = modeFor(source.id, settings);
  if (mode === MODE.OPEN_TAB) {
    console.log(`  ${source.id}: reads your tab - open ${hostFor(source.id)} in the browser to use it`);
    continue;
  }
  try {
    const adapter = getAdapter(source.id, {
      fetchImpl: browserFetch(catching),
      cookies,
      settings,
      sleep,
      logger: () => {},
    });
    const url = searchUrlFor(source.id, "iphone 13", settings);
    const result = await adapter.search({ searchText: "iphone 13", page: 1, perPage: 10 });
    console.log(
      `  ${source.id}: ${result.items.length} listing(s) via ${adapter.lastTransport || "?"} (${result.strategy}) from ${url}`,
    );
    for (const item of result.items.slice(0, 2)) console.log(`      ${item.price} ${item.currency} | ${item.title.slice(0, 48)}`);
  } catch (err) {
    console.log(`  ${source.id}: ${err.name}: ${String(err.message).slice(0, 160)}`);
  }
}

console.log("\n=== LEBONCOIN (live) ===");
const lbcWaits = [];
const lbc = new LeboncoinAdapter({
  fetchImpl: browserFetch(catching),
  cookies,
  sleep: (ms) => (lbcWaits.push(ms), Promise.resolve()),
  transport: "auto",
  logger: () => {},
});
try {
  const result = await lbc.search({ searchText: "iphone 13", page: 1, perPage: 24, order: "relevance", minPrice: 100, maxPrice: 700 });
  console.log(`items=${result.items.length} total=${result.totalEntries} transport=${lbc.transport}`);
  for (const item of result.items.slice(0, 3)) console.log(`  ${item.price} ${item.currency} | ${item.title.slice(0, 48)} | ${item.url}`);
} catch (err) {
  console.log(`${err.name}: ${err.message}`);
  console.log(`requests made=${lbc.requestsMade} waits=${lbcWaits.length}`);
}
