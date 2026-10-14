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

export const STATE_VERSION = 1;
export const RE_ALERT_DROP = 0.05;
export const LIMITS = { seenPerWatch: 3000, alerts: 500, log: 100 };

export const DEFAULT_SETTINGS = {
  intervalMinutes: 15,
  perPage: 96,
  notifications: true,
  leboncoinTransport: "auto",
  acknowledgeAll: false,
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
        state.alerts[key] = { ...existing, ...buildAlert(deal, key), status: existing.status };
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

  clearAlerts({ watch = null } = {}) {
    return this.mutate((state) => {
      const removed = Object.keys(state.alerts).filter((key) => !watch || state.alerts[key].watch === watch);
      for (const key of removed) delete state.alerts[key];
      return removed.length;
    });
  }

  // --- run bookkeeping -----------------------------------------------------

  recordRun(watchName, summary) {
    return this.mutate((state) => {
      state.runs[watchName] = summary;
      return summary;
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
    firstSeen: deal.firstSeen || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
