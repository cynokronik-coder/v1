/**
 * Persistent state: watches, settings, cached baselines, what we have seen and
 * what we have already alerted about.
 *
 * Two different dedupe keys, exactly as in the Python tool:
 *   listings -> "have I ever seen this item for this watch?"
 *   alerts   -> "have I already told the user about this bargain?"
 * A deal is re-reported only if the price dropped a further 5%, and never again
 * once the user marked it bought/hidden - the user's decision wins over ours.
 *
 * Storage is chrome.storage.local behind a tiny backend interface, so every rule
 * above is unit-tested in node against an in-memory backend.
 */

export const STATE_VERSION = 2;
export const RE_ALERT_DROP = 0.05;
export const LIMITS = {
  seenPerWatch: 3000,
  alerts: 500,
  log: 100,
  // The history page reads these: one row per scan pass per watch, plus one row
  // per opportunities run. Long enough to see a price trend, short enough that
  // chrome.storage.local stays small.
  history: 400,
  opportunityRuns: 50,
  opportunities: 80,
};

export const DEFAULT_SETTINGS = {
  intervalMinutes: 15,
  perPage: 96,
  notifications: true,
  leboncoinTransport: "auto",
  acknowledgeAll: false,
  // --- opportunities page -------------------------------------------------
  // eBay's keyset is the only credential this extension ever asks for, and it is
  // only used against eBay's own official API. Stored locally, like everything else.
  ebayClientId: "",
  ebayClientSecret: "",
  ebayMarketplaceId: "EBAY_FR",
  backmarketDomain: "www.backmarket.fr",
  opportunityIntervalMinutes: 720,
  opportunityMinMargin: 0.15, // 15% net margin after fees and shipping
  opportunityMinConfidence: "medium", // low | medium | high
  // What Back Market would pay for one of these (its trade-in quote), as opposed to what
  // it charges for one. One extra paced request per product, hence a switch.
  opportunityTradeIn: true,
  opportunityPerPage: 40,
  opportunityMaxProducts: 12, // how many catalogue entries one run samples
  trendSources: { wikipedia: true, gdelt: false },
  trendLanguage: "en",
  socialKeywords: [], // whatever the user sees trending, pasted in by hand

  // --- where the data comes from ------------------------------------------
  // One entry per marketplace, keyed by its id from core/sources.js:
  //   sources: { easycash: { enabled: true, mode: "open-tab", urlTemplate: "...",
  //                          acknowledgeTerms: false, actor: "user~actor" } }
  // Nothing is duplicated here: an absent entry means "use the registry's default".
  sources: {},
  // Third-party data providers: you bring the key, the extension makes the call.
  apifyToken: "",
  apifyActors: {}, // marketplace -> actor id, e.g. { vinted: "user~vinted-scraper" }
  serpApiKey: "",
  brightDataToken: "",
  brightDataZone: "",
  keepaKey: "",
  // Google Shopping as an extra resale reference (one SerpApi search per product,
  // so it is off until you ask for it: it costs money and it is not a marketplace).
  googleShoppingResale: false,
  // Apify as the fallback when a marketplace has no open tab and no usable URL.
  useApifyFallback: false,
};

export function defaultState() {
  return {
    version: STATE_VERSION,
    watches: [],
    settings: { ...DEFAULT_SETTINGS },
    baselines: {},
    seen: {},
    alerts: {},
    runs: {},
    history: [],
    catalog: [],
    opportunities: [],
    opportunityRuns: [],
    log: [],
  };
}

/** In-memory backend (tests, and the dashboard's preview mode). */
export function memoryBackend(initial = {}) {
  let data = { ...initial };
  return {
    async get() {
      return { ...data };
    },
    async set(next) {
      data = { ...next };
    },
    dump() {
      return { ...data };
    },
  };
}

/**
 * chrome.storage.local backend. Modern Chrome returns a promise; older builds only
 * take a callback, so both are supported instead of assuming one.
 */
export function chromeBackend(area) {
  async function get() {
    try {
      const maybe = area.get(null);
      if (maybe && typeof maybe.then === "function") return (await maybe) || {};
    } catch {
      // fall through to the callback form below
    }
    return new Promise((resolve) => area.get(null, (result) => resolve(result || {})));
  }

  async function set(next) {
    try {
      const maybe = area.set(next);
      if (maybe && typeof maybe.then === "function") {
        await maybe;
        return;
      }
    } catch {
      // fall through to the callback form below
    }
    await new Promise((resolve) => area.set(next, resolve));
  }

  return { get, set };
}

export class Store {
  constructor(backend, { persist = true, limits = LIMITS } = {}) {
    this.backend = backend;
    this.persist = persist;
    this.limits = limits;
    this.data = defaultState();
    this._queue = Promise.resolve();
  }

  async init() {
    const stored = await this.backend.get();
    this.data = { ...defaultState(), ...(stored || {}) };
    this.data.settings = { ...DEFAULT_SETTINGS, ...(stored?.settings || {}) };
    return this;
  }

  /** Merge partially-provided limits over the defaults (tests pass one or two). */
  _limit(name) {
    return this.limits?.[name] ?? LIMITS[name];
  }

  /** Trim an array to the configured cap, dropping the oldest entries. */
  _cap(list, name) {
    const cap = this._limit(name);
    if (typeof cap !== "number" || list.length <= cap) return list;
    return list.slice(0, cap);
  }

  /** Serialise writes: the scan loop and the UI both mutate the same state. */
  async mutate(fn) {
    this._queue = this._queue.then(async () => {
      const result = await fn(this.data);
      if (this.persist) await this.backend.set(this.data);
      return result;
    });
    return this._queue;
  }

  async reload() {
    const stored = await this.backend.get();
    this.data = { ...defaultState(), ...(stored || {}) };
    this.data.settings = { ...DEFAULT_SETTINGS, ...(stored?.settings || {}) };
    return this.data;
  }

  get settings() {
    return this.data.settings;
  }

  get watches() {
    return this.data.watches;
  }

  // --- configuration -------------------------------------------------------

  setWatches(watches) {
    return this.mutate((state) => {
      const names = new Set(watches.map((w) => w.name));
      // Drop state for watches the user deleted, so storage does not grow forever.
      for (const map of [state.baselines, state.seen, state.runs]) {
        for (const name of Object.keys(map)) if (!names.has(name)) delete map[name];
      }
      state.watches = watches;
      return watches.length;
    });
  }

  setSettings(patch) {
    return this.mutate((state) => {
      state.settings = { ...state.settings, ...patch };
      return state.settings;
    });
  }

  // --- listings and baselines ---------------------------------------------

  /** Record a listing; true when this (marketplace, item, watch) is new to us. */
  noteListing(listing, watchName) {
    return this.mutate((state) => {
      const bucket = (state.seen[watchName] = state.seen[watchName] || {});
      const key = `${listing.marketplace}:${listing.itemId}`;
      const isNew = !(key in bucket);
      bucket[key] = listing.price;
      const keys = Object.keys(bucket);
      if (keys.length > this.limits.seenPerWatch) {
        for (const stale of keys.slice(0, keys.length - this.limits.seenPerWatch)) delete bucket[stale];
      }
      return isNew;
    });
  }

  getBaseline(watchName, ttlSeconds = null) {
    const entry = this.data.baselines[watchName];
    if (!entry) return null;
    if (ttlSeconds !== null) {
      const age = (Date.now() - Date.parse(entry.computedAt)) / 1000;
      if (ttlSeconds >= 0 && age > ttlSeconds) return null;
    }
    return entry;
  }

  saveBaseline(watchName, stats, comparables) {
    return this.mutate((state) => {
      state.baselines[watchName] = {
        stats,
        comparables: comparables.slice(0, 200),
        computedAt: new Date().toISOString(),
      };
      return true;
    });
  }

  // --- alerts --------------------------------------------------------------

  /** True when the user should be told about this deal now. */
  markAlert(deal) {
    return this.mutate((state) => {
      const key = `${deal.watch}|${deal.listing.marketplace}|${deal.listing.itemId}`;
      const existing = state.alerts[key];
      const price = deal.listing.price;
      if (!existing) {
        state.alerts[key] = buildAlert(deal, key);
      } else {
        if (existing.status === "bought" || existing.status === "hidden") return false;
        if (!(price <= existing.price * (1 - RE_ALERT_DROP))) return false;
        // The user's own marks (status, favourite) always win over a refresh.
        state.alerts[key] = {
          ...existing,
          ...buildAlert(deal, key),
          status: existing.status,
          favourite: existing.favourite,
        };
      }
      const keys = Object.keys(state.alerts);
      if (keys.length > this.limits.alerts) {
        const sorted = keys.sort(
          (a, b) => Date.parse(state.alerts[a].firstSeen) - Date.parse(state.alerts[b].firstSeen),
        );
        for (const stale of sorted.slice(0, keys.length - this.limits.alerts)) delete state.alerts[stale];
      }
      return true;
    });
  }

  recentAlerts({ limit = 100, watch = null, status = null, sort = "firstSeen" } = {}) {
    let alerts = Object.values(this.data.alerts);
    if (watch) alerts = alerts.filter((a) => a.watch === watch);
    if (status) alerts = alerts.filter((a) => a.status === status);
    alerts.sort((a, b) => Date.parse(b[sort]) - Date.parse(a[sort]));
    return alerts.slice(0, limit);
  }

  setDealStatus(key, status) {
    return this.mutate((state) => {
      const alert = state.alerts[key];
      if (!alert) return null;
      alert.status = status;
      alert.statusChangedAt = new Date().toISOString();
      return alert;
    });
  }

  /** Star/unstar a deal. Favourites survive "clear deals" only if you ask them to. */
  setFavourite(key, favourite = true) {
    return this.mutate((state) => {
      const alert = state.alerts[key];
      if (!alert) return null;
      alert.favourite = Boolean(favourite);
      alert.favouriteChangedAt = new Date().toISOString();
      return alert;
    });
  }

  favourites() {
    return Object.values(this.data.alerts).filter((alert) => alert.favourite);
  }

  /** Delete stored deals; `keepFavourites` leaves the starred ones alone. */
  clearAlerts({ watch = null, keepFavourites = false } = {}) {
    return this.mutate((state) => {
      const removed = Object.keys(state.alerts).filter((key) => {
        const alert = state.alerts[key];
        if (watch && alert.watch !== watch) return false;
        if (keepFavourites && alert.favourite) return false;
        return true;
      });
      for (const key of removed) delete state.alerts[key];
      return removed.length;
    });
  }

  // --- run bookkeeping -----------------------------------------------------

  recordRun(watchName, summary) {
    return this.mutate((state) => {
      state.runs[watchName] = summary;
      // Keep a real scan history, not just the latest state per watch: the
      // History page is how you see whether a market moved or the filters broke.
      state.history = this._cap(
        [
          {
            at: summary.at || new Date().toISOString(),
            kind: "watch",
            watch: watchName,
            marketplace: summary.marketplace || null,
            marketPrice: summary.marketPrice ?? null,
            currency: summary.currency ?? null,
            comparables: summary.comparables ?? 0,
            deals: summary.deals ?? 0,
            newDeals: summary.newDeals ?? 0,
            requests: summary.requests ?? 0,
            error: summary.error ?? null,
            message: summary.message ?? null,
          },
          ...state.history,
        ],
        "history",
      );
      return summary;
    });
  }

  /** Rows for the History page: newest first, optionally one watch only. */
  recentHistory({ limit = 100, watch = null, kind = null } = {}) {
    let rows = this.data.history || [];
    if (watch) rows = rows.filter((row) => row.watch === watch);
    if (kind) rows = rows.filter((row) => row.kind === kind);
    return rows.slice(0, limit);
  }

  // --- opportunities --------------------------------------------------------

  /** The product catalogue the opportunities page samples (seeded on install). */
  setCatalog(items) {
    return this.mutate((state) => {
      state.catalog = items;
      return items.length;
    });
  }

  saveOpportunities(entries) {
    return this.mutate((state) => {
      state.opportunities = this._cap(entries, "opportunities");
      return state.opportunities.length;
    });
  }

  recordOpportunityRun(summary) {
    return this.mutate((state) => {
      state.opportunityRuns = this._cap(
        [{ at: new Date().toISOString(), ...summary }, ...(state.opportunityRuns || [])],
        "opportunityRuns",
      );
      // The opportunities run is part of the history the user scrolls through.
      state.history = this._cap(
        [
          {
            at: new Date().toISOString(),
            kind: "opportunities",
            watch: null,
            marketplace: null,
            products: summary.products ?? 0,
            deals: summary.verdicts?.buy ?? 0,
            newDeals: summary.verdicts?.watch ?? 0,
            requests: summary.requests ?? 0,
            error: summary.errors?.length ? "failed" : null,
            message: summary.errors?.[0] || null,
          },
          ...state.history,
        ],
        "history",
      );
      return state.opportunityRuns.length;
    });
  }

  /** Keep a short human-readable log: the dashboard shows it as "what happened". */
  appendLog(entry) {
    return this.mutate((state) => {
      state.log.unshift({ at: new Date().toISOString(), ...entry });
      state.log = state.log.slice(0, this.limits.log);
      return state.log.length;
    });
  }
}

function buildAlert(deal, key) {
  return {
    key,
    watch: deal.watch,
    marketplace: deal.listing.marketplace,
    itemId: deal.listing.itemId,
    title: deal.listing.title,
    url: deal.listing.url,
    imageUrl: deal.listing.imageUrl ?? null,
    price: deal.listing.price,
    currency: deal.listing.currency,
    landedPrice: deal.listing.landedPrice ?? null,
    marketPrice: deal.marketPrice,
    discountPct: Math.round(deal.discountPct * 10000) / 10000,
    robustZ: Math.round(deal.robustZ * 1000) / 1000,
    condition: deal.listing.condition ?? null,
    size: deal.listing.size ?? null,
    brand: deal.listing.brand ?? null,
    reasons: deal.reasons || [],
    status: "new",
    favourite: false,
    firstSeen: deal.firstSeen || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
