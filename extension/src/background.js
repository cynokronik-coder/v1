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
import { MarketplaceBlocked, MarketplaceError, Pacing } from "./core/adapters/base.js";
import { LEBONCOIN_PACING } from "./core/adapters/leboncoin.js";
import { VINTED_PACING } from "./core/adapters/vinted.js";
import { ConfigError, UNOFFICIAL_MARKETPLACES, normalizeWatch, normalizeWatches } from "./core/models.js";
import { replyWith } from "./core/messages.js";
import { notificationFor, dealPayload } from "./core/notify.js";
import { scanAll, skipReason, summarize } from "./core/scan.js";
import { Store, chromeBackend } from "./core/storage.js";

export const ALARM_NAME = "marketwatch-scan";
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
  logger = (...args) => console.log("[marketwatch]", ...args),
}) {
  const backend = chromeBackend(chrome.storage.local);
  const store = new Store(backend);
  let scanInFlight = null;

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
  const PACING_DEFAULTS = { vinted: VINTED_PACING, leboncoin: LEBONCOIN_PACING, lbc: LEBONCOIN_PACING };

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
    const common = {
      fetchImpl,
      cookies: cookieGetter(chrome),
      logger,
      pacing: pacerFor(pacers, marketplace),
      ...(sleep ? { sleep } : {}),
      ...(random ? { random } : {}),
    };
    if (watch.marketplace === "vinted") return getAdapter("vinted", { ...common, domain: watch.domain || "vinted.fr" });
    if (watch.marketplace === "leboncoin" || watch.marketplace === "lbc") {
      return getAdapter("leboncoin", {
        ...common,
        domain: watch.domain || "www.leboncoin.fr",
        transport: settings.leboncoinTransport || "auto",
      });
    }
    return getAdapter(watch.marketplace, common);
  }

  async function init() {
    await store.init();
    await ensureAlarm();
    return store.data;
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
      const settings = store.settings;
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

  // --- self check ---------------------------------------------------------

  /**
   * Reachability, from this browser, for each marketplace a watch uses. This is
   * the honest answer to "does it work for me?": Vinted and leboncoin may block a
   * script on a server, but here the request is made by the user's own browser
   * session, so the result is what actually happens on this machine.
   */
  async function selfCheck() {
    await store.init();
    const byMarketplace = new Map();
    for (const watch of store.watches) {
      if (!byMarketplace.has(watch.marketplace)) byMarketplace.set(watch.marketplace, watch);
    }
    if (byMarketplace.size === 0) byMarketplace.set("vinted", { marketplace: "vinted", searchText: "iphone 13" });

    const results = [];
    for (const [marketplace, watch] of byMarketplace) {
      const probe = { ...watch, name: watch.name || "probe", searchText: watch.searchText || "iphone 13" };
      if (UNOFFICIAL_MARKETPLACES[marketplace] && !probe.acknowledgeTerms) {
        results.push({
          marketplace,
          ok: false,
          detail:
            "not tested: this marketplace is not acknowledged for any watch yet. " +
            "Set 'terms acknowledged' on the watch first - see the README.",
        });
        continue;
      }
      try {
        const adapter = adapterFor({ ...probe, acknowledgeTerms: true }, store.settings);
        const query = { searchText: probe.searchText, filters: probe.filters || {}, page: 1, perPage: 5, order: "relevance" };
        const started = now();
        const result = await adapter.search(query);
        results.push({
          marketplace,
          ok: true,
          detail:
            `${result.items.length} listing(s) received in ${now() - started} ms` +
            (result.items[0] ? `, currency ${result.items[0].currency}` : "") +
            (result.totalEntries ? `, ${result.totalEntries} total` : ""),
        });
      } catch (err) {
        const blocked = err instanceof MarketplaceBlocked;
        results.push({
          marketplace,
          ok: false,
          detail: `${err.name}: ${err.message}`,
          advice: blocked
            ? "Browse this marketplace in a normal tab first (so the browser holds a real session), then try again."
            : "Check your internet connection, then try again.",
        });
      }
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
      baselines: Object.fromEntries(
        Object.entries(data.baselines).map(([name, entry]) => [
          name,
          { stats: entry.stats, computedAt: entry.computedAt, comparables: (entry.comparables || []).slice(0, 10) },
        ]),
      ),
      log: data.log.slice(0, 20),
      unofficialMarketplaces: Object.keys(UNOFFICIAL_MARKETPLACES),
    };
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
        return { ...stateView(), nextRunAt: await nextRunAt(), scanning: Boolean(scanInFlight) };
      }
      case "scan":
        return runScan({ force: Boolean(message.force), reason: message.reason || "manual" });
      case "selfCheck":
        return { results: await selfCheck() };
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
        await store.setSettings(patch);
        await reconfigureAlarm();
        return { ok: true, settings: store.settings };
      }
      case "setDealStatus": {
        const alert = await store.setDealStatus(message.key, message.status);
        await updateBadge();
        return { ok: Boolean(alert), alert };
      }
      case "clearAlerts": {
        const removed = await store.clearAlerts({ watch: message.watch || null });
        await updateBadge();
        await addLog("info", `cleared ${removed} deal(s)`);
        return { ok: true, removed };
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
    selfCheck,
    resolveNotification,
    handleMessage,
    reconfigureAlarm,
    ensureAlarm,
    nextRunAt,
    updateBadge,
    notifyDeals,
    seedDemoWatch,
    stateView,
  };
}

// --- real world wiring -------------------------------------------------------

const isBrowser = typeof chrome !== "undefined" && chrome?.runtime?.id;

export const controller = isBrowser
  ? createController({ chrome, fetchImpl: browserFetch() })
  : null;

if (isBrowser) {
  const ready = controller.init();

  chrome.runtime.onInstalled.addListener(async () => {
    await ready;
    await controller.seedDemoWatch();
    await controller.reconfigureAlarm();
    await controller.runScan({ force: true, reason: "install" });
    await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });

  chrome.runtime.onStartup.addListener(async () => {
    await ready;
    await controller.reconfigureAlarm();
  });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    await ready;
    await controller.runScan({ reason: "schedule" });
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
