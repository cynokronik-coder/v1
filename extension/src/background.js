/**
 * Service worker: scheduling, scanning, notifications, and the message API the
 * dashboard talks to.
 *
 * The logic lives in `createController`, which takes its `chrome` and `fetch` as
 * arguments. The bottom of this file wires the real ones up. That split is
 * deliberate: it means the whole scan -> notify -> badge -> storage path can be
 * tested in node with a fake chrome API (tests/background.test.js), instead of
 * only by clicking around a browser.
 */

import { getAdapter } from "./core/adapters/index.js";
import { MarketplaceBlocked, MarketplaceError, ORDER, Pacing } from "./core/adapters/base.js";
import { BACKMARKET_PACING } from "./core/adapters/backmarket.js";
import { EBAY_PACING } from "./core/adapters/ebay.js";
import { LEBONCOIN_PACING } from "./core/adapters/leboncoin.js";
import { VINTED_PACING } from "./core/adapters/vinted.js";
import { DEFAULT_CATALOG, normalizeCatalog } from "./core/catalog.js";
import { buildStats } from "./core/analyzer.js";
import { ConfigError, UNOFFICIAL_MARKETPLACES, normalizeWatch, normalizeWatches, slimListing } from "./core/models.js";
import { replyWith } from "./core/messages.js";
import { notificationFor, dealPayload } from "./core/notify.js";
import { runOpportunityScan, summarizeOpportunities } from "./core/opportunity-scan.js";
import { createApifyAdapter, serpApiShopping, serpApiTrends } from "./core/providers.js";
import {
  MODE,
  PROVIDERS,
  SOURCES,
  SOURCE_IDS,
  credentialKeysFor,
  describeSource,
  hostFor,
  modeFor,
  sourceById,
  sourceConfig,
  sourceEnabled,
  sourceReady,
} from "./core/sources.js";
import { DEFAULT_PER_PAGE, scanAll, skipReason, summarize } from "./core/scan.js";
import { Store, chromeBackend } from "./core/storage.js";
import { createTabTransport } from "./core/tab-transport.js";

export const ALARM_NAME = "marketwatch-scan";
export const OPPORTUNITY_ALARM_NAME = "marketwatch-opportunities";
export const DEMO_WATCH = {
  name: "demo-offline",
  marketplace: "mock",
  searchText: "pixel 8",
  minDiscount: 0.3,
  maxRobustZ: null,
  minSampleSize: 10,
  plausibleMinPrice: 20,
  plausibleMaxPrice: 2000,
};

export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 24 * 60;
export const DEFAULT_INTERVAL_MINUTES = 15;

/**
 * Chrome alarm periods are minutes. Anything below a minute would have us scanning
 * constantly for no benefit, so 0/"banana" mean "as fast as allowed" / "default"
 * rather than "never scan again".
 */
export function clampIntervalMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MINUTES;
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(n)));
}

/** Wrap the platform fetch into the {status, body, headers} shape adapters use. */
export function browserFetch(realFetch = globalThis.fetch) {
  return async (url, init = {}) => {
    const response = await realFetch(url, init);
    return {
      status: response.status,
      body: await response.text(),
      headers: response.headers,
      url: response.url,
    };
  };
}

/** Read one cookie for a URL, so the Vinted adapter can echo the anon id. */
export function cookieGetter(chromeApi) {
  return (url, name) =>
    new Promise((resolve) => {
      try {
        chromeApi.cookies.get({ url, name }, (cookie) => {
          void chromeApi.runtime.lastError;
          resolve(cookie?.value ?? null);
        });
      } catch {
        resolve(null);
      }
    });
}

export function createController({
  chrome,
  fetchImpl,
  now = () => Date.now(),
  // `sleep`/`random` exist so tests can run the real pacing logic without the real
  // wall-clock wait; production always uses the adapter defaults.
  sleep,
  random,
  // `tabTransport` lets a marketplace request be made by one of the user's own
  // tabs (see core/tab-transport.js); `trendFetch` reads the public interest
  // signals on the opportunities page. Both are injected so they can be faked.
  tabTransport = null,
  trendFetch = null,
  logger = (...args) => console.log("[marketwatch]", ...args),
}) {
  const backend = chromeBackend(chrome.storage.local);
  const store = new Store(backend);
  const trends = trendFetch || fetchImpl;
  let scanInFlight = null;
  let opportunityInFlight = null;

  const notifications = {
    async create(id, options) {
      return new Promise((resolve) => chrome.notifications.create(id, options, resolve));
    },
    async clear(id) {
      return new Promise((resolve) => chrome.notifications.clear(id, resolve));
    },
  };

  /** Per-marketplace pacing constants, so a shared pacer keeps each marketplace's
   *  own pace rather than the tightest one. */
  const PACING_DEFAULTS = {
    vinted: VINTED_PACING,
    leboncoin: LEBONCOIN_PACING,
    lbc: LEBONCOIN_PACING,
    ebay: EBAY_PACING,
    backmarket: BACKMARKET_PACING,
    // Every other marketplace brings its own pace from the registry, so adding one
    // does not mean remembering to add it here as well.
    ...Object.fromEntries(SOURCES.map((source) => [source.id, source.pacing])),
  };

  /** One pacer per marketplace per scan: two watches on vinted still get a gap
   *  between their requests, and no marketplace sees a burst at scan start. */
  function pacerFor(pacers, marketplace) {
    if (!pacers) return undefined;
    const key = marketplace === "lbc" ? "leboncoin" : marketplace;
    if (!pacers.has(key)) {
      pacers.set(key, new Pacing({ ...(PACING_DEFAULTS[key] || {}), sleep, random }));
    }
    return pacers.get(key);
  }

  function adapterFor(watch, settings, pacers) {
    const marketplace = watch.marketplace === "lbc" ? "leboncoin" : watch.marketplace;
    const source = sourceById(marketplace);
    // Taught once, inherited by every adapter: the tab transport, the user's
    // per-source settings and the shared pacer all arrive the same way.
    const common = {
      fetchImpl,
      cookies: cookieGetter(chrome),
      logger,
      pacing: pacerFor(pacers, marketplace),
      tabTransport,
      settings,
      ...(sleep ? { sleep } : {}),
      ...(random ? { random } : {}),
    };
    if (marketplace === "vinted") return getAdapter("vinted", { ...common, domain: watch.domain || "vinted.fr" });
    if (marketplace === "leboncoin") {
      return getAdapter("leboncoin", {
        ...common,
        domain: watch.domain || "www.leboncoin.fr",
        transport: settings.leboncoinTransport || "auto",
      });
    }
    if (marketplace === "ebay") return getAdapter("ebay", { ...common, ...ebayOptions(settings) });
    if (marketplace === "backmarket") {
      return getAdapter("backmarket", { ...common, domain: settings.backmarketDomain || undefined });
    }
    // A page source with no tab to borrow and no URL template is where the
    // optional Apify fallback comes in: only when the user configured both.
    if (
      source &&
      source.access === "page" &&
      settings.useApifyFallback &&
      settings.apifyToken &&
      (settings.sources?.[source.id]?.actor || settings.apifyActors?.[source.id]) &&
      modeFor(source.id, settings) === MODE.OPEN_TAB
    ) {
      const fallback = createApifyAdapter({ settings, fetchImpl, marketplace: source.id, logger });
      logger(`${source.id}: no search URL configured, using the Apify actor ${fallback.actor}`);
      return fallback;
    }
    return getAdapter(marketplace, { ...common, domain: hostFor(source?.id) || null });
  }

  /** Which credentialed marketplaces are usable right now, straight from the registry. */
  function credentials(settings) {
    return Object.fromEntries(
      SOURCES.filter((source) => source.credentials).map((source) => [source.id, sourceReady(source.id, settings)]),
    );
  }

  /** eBay's keys come from settings, like every other source's. */
  function ebayOptions(settings) {
    return {
      clientId: settings.ebayClientId || null,
      clientSecret: settings.ebayClientSecret || null,
      marketplaceId: settings.ebayMarketplaceId || undefined,
    };
  }

  async function init() {
    await store.init();
    await ensureCatalog();
    await ensureAlarm();
    await ensureOpportunityAlarm();
    return store.data;
  }

  /** First run (or after a reset): give the opportunities page something to sample. */
  async function ensureCatalog() {
    await store.init();
    if ((store.data.catalog || []).length) return false;
    await store.setCatalog(normalizeCatalog(DEFAULT_CATALOG));
    return true;
  }

  async function loadState() {
    await store.init();
    return store.data;
  }

  // --- scheduling ---------------------------------------------------------

  async function reconfigureAlarm() {
    const minutes = clampIntervalMinutes(store.settings.intervalMinutes);
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes, delayInMinutes: minutes });
    return minutes;
  }

  /**
   * The opportunities run is much more expensive (many products x two markets x
   * trend signals), so it gets its own, much slower schedule - 12 h by default.
   */
  async function reconfigureOpportunityAlarm() {
    const minutes = clampIntervalMinutes(store.settings.opportunityIntervalMinutes ?? 720);
    await chrome.alarms.create(OPPORTUNITY_ALARM_NAME, { periodInMinutes: minutes, delayInMinutes: minutes });
    return minutes;
  }

  async function ensureOpportunityAlarm() {
    const existing = await chrome.alarms.get(OPPORTUNITY_ALARM_NAME);
    if (existing) return existing.periodInMinutes;
    return reconfigureOpportunityAlarm();
  }

  async function nextOpportunityRunAt() {
    const alarm = await chrome.alarms.get(OPPORTUNITY_ALARM_NAME);
    return alarm?.scheduledTime ?? null;
  }

  /** Any entry point may be the first thing a cold worker runs, so make sure the
   *  schedule is armed; never recreate an existing alarm, which would postpone it. */
  async function ensureAlarm() {
    const existing = await chrome.alarms.get(ALARM_NAME);
    if (existing) return existing.periodInMinutes;
    return reconfigureAlarm();
  }

  async function nextRunAt() {
    const alarm = await chrome.alarms.get(ALARM_NAME);
    return alarm?.scheduledTime ?? null;
  }

  // --- alerts -------------------------------------------------------------

  async function notifyDeals(reports) {
    if (!store.settings.notifications) return 0;
    let sent = 0;
    for (const report of reports) {
      for (const deal of report.newDeals) {
        const payload = dealPayload(deal);
        const options = notificationFor(deal, { iconUrl: chrome.runtime.getURL("icons/icon128.png") });
        options.contextMessage = `${options.contextMessage} · ${(deal.discountPct * 100).toFixed(0)}% under market`;
        // The notification id is the alert key, so clicking it can find the listing
        // again even after the worker has been shut down and restarted.
        await notifications.create(payload.key, options);
        sent += 1;
      }
    }
    return sent;
  }

  async function pendingCount() {
    return Object.values(store.data.alerts).filter((a) => a.status === "new").length;
  }

  async function updateBadge() {
    const count = await pendingCount();
    await chrome.action.setBadgeText({ text: count ? String(count) : "" });
    if (count) await chrome.action.setBadgeBackgroundColor({ color: "#2ea043" });
    return count;
  }

  // --- scanning -----------------------------------------------------------

  async function runScan({ force = false, reason = "manual" } = {}) {
    if (scanInFlight) return scanInFlight;
    scanInFlight = (async () => {
      await store.init();
      await store.reload(); // the dashboard may have changed watches since we woke
      const watched = store.watches;
      const settings = { ...store.settings, credentials: credentials(store.settings) };
      const startedAt = now();

      const pacers = new Map(); // shared across this scan only
      const reports = await scanAll({
        watches: watched,
        store,
        settings,
        adapterFactory: (watch) => adapterFor(watch, settings, pacers),
        forceBaseline: force,
        logger,
      });

      const newDeals = await notifyDeals(reports);
      await store.appendLog({
        level: reports.some((r) => r.error) ? "warn" : "info",
        message:
          `scan (${reason}): ${reports.length} watch(es), ` +
          `${reports.reduce((n, r) => n + r.deals.length, 0)} deal(s), ${newDeals} alert(s)` +
          (reports.some((r) => r.error) ? `, ${reports.filter((r) => r.error).length} with an error` : ""),
      });
      const badge = await updateBadge();
      return {
        ok: true,
        summary: summarize(reports),
        newDeals,
        badge,
        durationMs: now() - startedAt,
        reports: reports.map((r) => ({
          watch: r.watch,
          deals: r.deals.length,
          newDeals: r.newDeals.length,
          error: r.error,
          notes: r.notes,
        })),
      };
    })().finally(() => {
      scanInFlight = null;
    });
    return scanInFlight;
  }

  // --- opportunities ------------------------------------------------------

  /**
   * Sample the buy side, sample the resale side, read the trend signals, score the
   * difference. Slower and much more request-hungry than a watch scan, so it runs
   * on its own alarm and stores its own history rows.
   */
  async function runOpportunities({ reason = "manual" } = {}) {
    if (opportunityInFlight) return opportunityInFlight;
    opportunityInFlight = (async () => {
      await store.init();
      await store.reload();
      await ensureCatalog();
      const settings = { ...store.settings, credentials: credentials(store.settings) };
      const startedAt = now();
      const pacers = new Map();

      const { opportunities, summary, notes } = await runOpportunityScan({
        catalog: store.data.catalog || [],
        settings,
        trendFetch: trends,
        now,
        logger,
        adapterFactory: ({ marketplace, product }) => {
          const probe = {
            marketplace,
            domain: marketplace === "backmarket" ? settings.backmarketDomain : null,
            acknowledgeTerms: Boolean(product.acknowledgeTerms),
          };
          return adapterFor(probe, settings, pacers);
        },
        // Both of these are off unless the user pasted the matching key: they cost
        // money per call, and a resale reference you pay for should be asked for.
        providerResale: settings.googleShoppingResale && settings.serpApiKey
          ? async (product) => (await serpApiShopping({ settings, fetchImpl, query: product.keyword, logger })).items
          : null,
        providerTrend: settings.serpApiKey && settings.trendSources?.googleTrends
          ? async (product) => serpApiTrends({ settings, fetchImpl, query: product.keyword, logger })
          : null,
      });

      await store.saveOpportunities(opportunities);
      await store.recordOpportunityRun({ ...summary, reason });
      const best = summarizeOpportunities(opportunities).best;
      await store.appendLog({
        level: notes.length ? "warn" : "info",
        message:
          `opportunities (${reason}): ${summary.products} product(s) measured, ` +
          `${summary.verdicts.buy} worth buying, ${summary.requests} request(s)` +
          (notes.length ? `, ${notes.length} note(s)` : ""),
      });
      return {
        ok: true,
        summary: { ...summary, durationMs: now() - startedAt },
        best,
        opportunities,
        notes,
      };
    })().finally(() => {
      opportunityInFlight = null;
    });
    return opportunityInFlight;
  }

  // --- self check ---------------------------------------------------------

  /**
   * Reachability, from this browser, for each marketplace a watch uses. This is
   * the honest answer to "does it work for me?": Vinted and leboncoin may block a
   * script on a server, but here the request is made by the user's own browser
   * session, so the result is what actually happens on this machine.
   */
  /** One real request against one marketplace, reported exactly as it went. */
  async function probeSource(marketplace, probe, settings) {
    const source = sourceById(marketplace);
    try {
      const adapter = adapterFor({ ...probe, acknowledgeTerms: true }, settings);
      const query = {
        searchText: probe.searchText,
        filters: probe.filters || {},
        page: 1,
        perPage: 5,
        order: "relevance",
      };
      const started = now();
      const result = await adapter.search(query);
      return {
        marketplace,
        label: source?.label || marketplace,
        ok: true,
        provider: adapter.provider || null,
        detail:
          `${result.items.length} listing(s) received in ${now() - started} ms` +
          (result.items[0] ? `, currency ${result.items[0].currency}` : "") +
          (result.totalEntries ? `, ${result.totalEntries} total` : "") +
          (adapter.lastTransport || adapter.lastSource ? ` · via ${adapter.lastTransport || adapter.lastSource}` : ""),
      };
    } catch (err) {
      const blocked = err instanceof MarketplaceBlocked;
      return {
        marketplace,
        label: source?.label || marketplace,
        ok: false,
        detail: `${err.name}: ${err.message}`,
        advice: blocked
          ? "Browse this marketplace in a normal tab first (so the browser holds a real session), " +
            `then try again.${source?.advice ? ` ${source.advice}` : ""}`
          : "Check your internet connection, then try again - or switch this source to 'reads your tab'.",
      };
    }
  }

  /**
   * "How much does this cost?" - one keyword, one marketplace, straight to a median.
   *
   * This is the estimator the scans use, without a watch or a catalogue entry: it
   * exists because comparing a listing against a number is only honest if you can
   * see the number for yourself. One request, one page, no caching and nothing
   * stored - so it never changes what a scan would find.
   */
  async function priceCheck(message = {}) {
    await store.init();
    const settings = { ...store.settings, credentials: credentials(store.settings) };
    const marketplace = message.marketplace === "lbc" ? "leboncoin" : message.marketplace;
    const keyword = String(message.keyword || "").trim();
    const source = sourceById(marketplace);
    if (!source) throw new ConfigError(`unknown marketplace '${marketplace}' (expected: ${SOURCE_IDS.join(" | ")})`);
    if (!keyword) throw new ConfigError("type something to search for");
    if (!sourceEnabled(marketplace, settings)) {
      throw new ConfigError(`${source.label} is switched off - turn it on in the Marketplaces page`);
    }
    if (settings.credentials?.[marketplace] === false) {
      throw new ConfigError(
        `${source.label} needs credentials first: ${(credentialKeysFor(marketplace) || []).join(", ")} in Settings`,
      );
    }

    const bound = (value) => {
      const n = Number(value);
      return value === "" || value === null || value === undefined || !Number.isFinite(n) ? null : n;
    };
    // `acknowledgeTerms: true` is the same choice "Test this source" makes: this is a
    // single request the user asked for by name, not a background collection run.
    const adapter = adapterFor({ marketplace, domain: source.hosts?.[0] || null, acknowledgeTerms: true }, settings);
    const started = now();
    let result;
    try {
      result = await adapter.search({
        searchText: keyword,
        filters: {},
        minPrice: bound(message.minPrice),
        maxPrice: bound(message.maxPrice),
        page: 1,
        perPage: settings.perPage || DEFAULT_PER_PAGE,
        order: ORDER.RELEVANCE,
        currency: null,
      });
    } catch (err) {
      const blocked = err instanceof MarketplaceBlocked;
      return {
        ok: false,
        marketplace,
        label: source.label,
        keyword,
        detail: `${err.name}: ${err.message}`,
        advice: blocked
          ? "Browse this marketplace in a normal tab first, then try again."
          : "Check your connection, then try again - or switch this source to 'reads your tab'.",
      };
    }

    const items = (result.items || []).filter((item) => typeof item.price === "number" && item.price > 0);
    if (!items.length) {
      return {
        ok: false,
        marketplace,
        label: source.label,
        keyword,
        detail: "the marketplace answered, but returned no listing with a readable price",
        advice: source.advice || "Try a shorter keyword, or widen the price band.",
      };
    }
    const currency = items[0].currency || "EUR";
    const stats = buildStats(items.map((item) => item.price), currency);
    const cheapest = [...items].sort((a, b) => a.price - b.price).slice(0, 8).map(slimListing);
    return {
      ok: true,
      marketplace,
      label: source.label,
      keyword,
      currency,
      stats,
      checked: items.length,
      totalEntries: result.totalEntries ?? null,
      cheapest,
      durationMs: now() - started,
      via: adapter.lastTransport || adapter.lastSource || null,
    };
  }

  async function selfCheck({ marketplace = null } = {}) {
    await store.init();
    const settings = { ...store.settings, credentials: credentials(store.settings) };
    const byMarketplace = new Map();
    for (const watch of store.watches) {
      if (!byMarketplace.has(watch.marketplace)) byMarketplace.set(watch.marketplace, watch);
    }
    if (marketplace) {
      const watch = byMarketplace.get(marketplace) || { marketplace, searchText: "iphone 13" };
      byMarketplace.clear();
      byMarketplace.set(marketplace, watch);
    }
    if (byMarketplace.size === 0) byMarketplace.set("vinted", { marketplace: "vinted", searchText: "iphone 13" });

    const results = [];
    for (const [id, watch] of byMarketplace) {
      const probe = { ...watch, name: watch.name || "probe", searchText: watch.searchText || "iphone 13" };
      const acknowledged =
        probe.acknowledgeTerms ||
        settings.acknowledgeAll ||
        sourceConfig(id, settings).acknowledgeTerms === true ||
        // "Test this source" on the Marketplaces page is itself the acknowledgement for
        // that one request, otherwise the button could never tell you anything.
        Boolean(marketplace);
      if (UNOFFICIAL_MARKETPLACES[id] && !acknowledged) {
        results.push({
          marketplace: id,
          label: sourceById(id)?.label || id,
          ok: false,
          detail:
            "not tested: this marketplace is not acknowledged for any watch yet. " +
            "Set 'terms acknowledged' on the watch first - see the README.",
        });
        continue;
      }
      results.push(await probeSource(id, probe, settings));
    }
    return results;
  }

  // --- message API --------------------------------------------------------

  function stateView() {
    const data = store.data;
    return {
      watches: data.watches,
      settings: data.settings,
      alerts: Object.values(data.alerts),
      runs: data.runs,
      // The history page and the opportunities page read these.
      history: (data.history || []).slice(0, 200),
      catalog: data.catalog || [],
      opportunities: data.opportunities || [],
      opportunityRuns: (data.opportunityRuns || []).slice(0, 20),
      baselines: Object.fromEntries(
        Object.entries(data.baselines).map(([name, entry]) => [
          name,
          { stats: entry.stats, computedAt: entry.computedAt, comparables: (entry.comparables || []).slice(0, 10) },
        ]),
      ),
      log: data.log.slice(0, 20),
      unofficialMarketplaces: Object.keys(UNOFFICIAL_MARKETPLACES),
      // The Marketplaces page is a loop over these two lists, so it can never list a
      // marketplace the engine does not have (or hide one it does).
      sources: SOURCES.map((source) => {
        const described = describeSource(source.id, { settings: data.settings });
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
          enabled: sourceEnabled(source.id, data.settings),
          credentialReady: sourceReady(source.id, data.settings),
          credentials: source.credentials
            ? { ...source.credentials, missing: credentialKeysFor(source.id).filter((key) => !data.settings[key]) }
            : null,
          settings: sourceConfig(source.id, data.settings),
        };
      }),
      providers: PROVIDERS.map((provider) => ({
        id: provider.id,
        label: provider.label,
        docsUrl: provider.docsUrl,
        signupUrl: provider.signupUrl,
        freeTier: provider.freeTier,
        what: provider.what,
        legal: provider.legal,
        covers: provider.covers,
        keys: provider.keys,
        configured: provider.keys.every((entry) => Boolean(data.settings[entry.key])),
      })),
    };
  }

  /**
   * Does the browser hold a usable session for a marketplace right now? Used by the
   * self-check to say *why* leboncoin fails and whether a tab would fix it.
   */
  async function tabStatus() {
    const out = {};
    for (const source of SOURCES) {
      if (!source.hosts?.length) continue;
      if (!tabTransport?.available) {
        out[source.id] = false;
        continue;
      }
      out[source.id] = Boolean(await tabTransport.available(source.hosts).catch(() => false));
    }
    return out;
  }

  /** A notification was clicked: open the listing it was about. */
  async function resolveNotification(key) {
    await store.init(); // a notification click can wake a cold worker
    const alert = store.data.alerts[key];
    if (!alert) return { ok: false, reason: "that deal is no longer stored" };
    await chrome.tabs.create({ url: alert.url });
    return { ok: true, url: alert.url };
  }

  async function addLog(level, message) {
    return store.appendLog({ level, message });
  }

  async function handleMessage(message = {}) {
    const { type } = message;
    switch (type) {
      case "getState": {
        await store.init();
        await ensureCatalog();
        return {
          ...stateView(),
          nextRunAt: await nextRunAt(),
          nextOpportunityRunAt: await nextOpportunityRunAt(),
          scanning: Boolean(scanInFlight),
          opportunityScanning: Boolean(opportunityInFlight),
          tabs: await tabStatus(),
        };
      }
      case "scan":
        return runScan({ force: Boolean(message.force), reason: message.reason || "manual" });
      case "scanOpportunities":
        return runOpportunities({ reason: message.reason || "manual" });
      case "selfCheck":
        return { results: await selfCheck({ marketplace: message.marketplace || null }) };
      case "priceCheck":
        return priceCheck(message);
      case "setSource": {
        // Per-source switch, mode, URL template and terms acknowledgement.
        await store.init();
        const patch = { ...(store.settings.sources || {}) };
        const id = message.marketplace;
        if (!sourceById(id)) throw new ConfigError(`unknown source '${id}' (expected: ${SOURCE_IDS.join(" | ")})`);
        patch[id] = { ...(patch[id] || {}), ...(message.patch || {}) };
        await store.setSettings({ sources: patch });
        await addLog("info", `${sourceById(id).label}: ${Object.keys(message.patch || {}).join(", ")} updated`);
        return { ok: true, sources: store.settings.sources };
      }
      case "setFavourite": {
        const alert = await store.setFavourite(message.key, message.favourite !== false);
        return { ok: Boolean(alert), alert };
      }
      case "setCatalog": {
        const catalog = normalizeCatalog(message.catalog || []);
        await store.setCatalog(catalog);
        await addLog("info", `saved ${catalog.length} catalogue product(s)`);
        return { ok: true, catalog };
      }
      case "clearAlerts": {
        const removed = await store.clearAlerts({
          watch: message.watch || null,
          keepFavourites: Boolean(message.keepFavourites),
        });
        await updateBadge();
        await addLog("info", `cleared ${removed} deal(s)`);
        return { ok: true, removed };
      }
      case "setWatches": {
        const watches = normalizeWatches(message.watches || [], message.defaults || {});
        await store.setWatches(watches);
        await reconfigureAlarm();
        await addLog("info", `saved ${watches.length} watch(es)`);
        return { ok: true, watches };
      }
      case "setSettings": {
        const patch = { ...(message.settings || {}) };
        // Store what is actually in effect, so the dashboard cannot show "0 min"
        // while the alarm runs at 1.
        if (patch.intervalMinutes !== undefined) patch.intervalMinutes = clampIntervalMinutes(patch.intervalMinutes);
        if (patch.opportunityIntervalMinutes !== undefined) {
          patch.opportunityIntervalMinutes = clampIntervalMinutes(patch.opportunityIntervalMinutes);
        }
        await store.setSettings(patch);
        await reconfigureAlarm();
        await reconfigureOpportunityAlarm();
        return { ok: true, settings: store.settings };
      }
      case "setDealStatus": {
        const alert = await store.setDealStatus(message.key, message.status);
        await updateBadge();
        return { ok: Boolean(alert), alert };
      }
      case "openListing": {
        await chrome.tabs.create({ url: message.url });
        return { ok: true };
      }
      case "openDashboard": {
        await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
        return { ok: true };
      }
      case "resolveNotification":
        return resolveNotification(message.key);
      case "addDemoWatch": {
        // The dashboard's first-run button: something to look at with no network.
        const added = await seedDemoWatch();
        return { ok: true, added, watches: store.watches };
      }
      case "notifyTest": {
        // Proves notifications work without waiting for a real bargain.
        await notifications.create("marketwatch|test|0", {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title: "marketwatch is watching",
          message: "This is what a bargain alert looks like. Click it to open the dashboard.",
          contextMessage: "test notification",
        });
        return { ok: true };
      }
      default:
        throw new ConfigError(`unknown message type '${type}'`);
    }
  }

  /** First run: give the user something that works immediately, with no network. */
  async function seedDemoWatch() {
    await store.init();
    if (store.watches.length) return false;
    await store.setWatches([normalizeWatch(DEMO_WATCH)]);
    await addLog("info", "added the offline demo watch so you can see it work before adding real products");
    return true;
  }

  return {
    store,
    adapterFor,
    init,
    loadState,
    runScan,
    runOpportunities,
    ensureCatalog,
    selfCheck,
    resolveNotification,
    handleMessage,
    reconfigureAlarm,
    reconfigureOpportunityAlarm,
    ensureAlarm,
    ensureOpportunityAlarm,
    nextRunAt,
    nextOpportunityRunAt,
    tabStatus,
    updateBadge,
    notifyDeals,
    seedDemoWatch,
    stateView,
  };
}

// --- real world wiring -------------------------------------------------------

const isBrowser = typeof chrome !== "undefined" && chrome?.runtime?.id;

/** The tab transport needs the `scripting` permission; without it everything else
 *  still works, leboncoin just falls back to the service-worker transports. */
export function buildTabTransport(chromeApi = chrome) {
  if (!chromeApi?.scripting || !chromeApi?.tabs) return null;
  try {
    return createTabTransport({ chrome: chromeApi });
  } catch (err) {
    console.warn("[marketwatch] tab transport unavailable:", err?.message || err);
    return null;
  }
}

export const controller = isBrowser
  ? createController({ chrome, fetchImpl: browserFetch(), tabTransport: buildTabTransport(chrome) })
  : null;

if (isBrowser) {
  const ready = controller.init();

  chrome.runtime.onInstalled.addListener(async () => {
    await ready;
    await controller.seedDemoWatch();
    await controller.ensureCatalog();
    await controller.reconfigureAlarm();
    await controller.reconfigureOpportunityAlarm();
    await controller.runScan({ force: true, reason: "install" });
    await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });

  chrome.runtime.onStartup.addListener(async () => {
    await ready;
    await controller.reconfigureAlarm();
    await controller.reconfigureOpportunityAlarm();
  });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== ALARM_NAME && alarm.name !== OPPORTUNITY_ALARM_NAME) return;
    await ready;
    if (alarm.name === OPPORTUNITY_ALARM_NAME) await controller.runOpportunities({ reason: "schedule" });
    else await controller.runScan({ reason: "schedule" });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) =>
    // Every reply is { ok, result } or { ok, error }: see src/core/messages.js.
    replyWith(sendResponse, ready.then(() => controller.handleMessage(message))),
  );

  chrome.notifications.onClicked.addListener(async (notificationId) => {
    await ready;
    await controller.resolveNotification(notificationId);
  });

  // The "Open listing" button (not supported on every platform, hence also the
  // plain click above).
  chrome.notifications.onButtonClicked.addListener(async (notificationId) => {
    await ready;
    await controller.resolveNotification(notificationId);
    await chrome.notifications.clear(notificationId);
  });

  chrome.action.onClicked.addListener(async () => {
    await ready;
    await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });
}

export { MarketplaceBlocked, MarketplaceError, skipReason };
