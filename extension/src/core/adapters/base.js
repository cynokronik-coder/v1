/**
 * Adapter primitives: error taxonomy and request pacing.
 *
 * Differences from the Python version worth knowing:
 *
 *  * The browser owns the request identity. `fetch()` refuses to set forbidden
 *    headers (User-Agent, Origin, Cookie), so there is nothing to spoof here: the
 *    request carries the user's real Chrome user agent and their real cookie jar
 *    (`credentials: "include"`), which is exactly why this extension gets further
 *    than a script on a server.
 *  * Extension service workers with host permissions are not subject to CORS for
 *    those hosts, so the marketplace APIs are reachable without a proxy.
 *  * We still pace ourselves, and still stop rather than evade a block.
 */

export class MarketplaceError extends Error {
  constructor(message) {
    super(message);
    this.name = "MarketplaceError";
  }
}

/** The marketplace refused automated access (403 / challenge page). We stop. */
export class MarketplaceBlocked extends MarketplaceError {
  constructor(message) {
    super(message);
    this.name = "MarketplaceBlocked";
  }
}

export class MarketplaceRateLimited extends MarketplaceError {
  constructor(message, retryAfter = null) {
    super(message);
    this.name = "MarketplaceRateLimited";
    this.retryAfter = retryAfter;
  }
}

export const ORDER = {
  RELEVANCE: "relevance",
  NEWEST: "newest",
  PRICE_ASC: "price_asc",
  PRICE_DESC: "price_desc",
};

/**
 * Serialised, jittered pacing. Deliberately sequential: parallel workers are what
 * gets an IP or an account blocked, and a price baseline does not need the speed.
 */
export class Pacing {
  constructor({ minIntervalMs = 6000, jitterMs = 3000, sleep = defaultSleep, random = Math.random } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.jitterMs = jitterMs;
    this._sleep = sleep;
    this._random = random;
    this._lastRequestAt = 0;
    this.requestsMade = 0;
  }

  reset() {
    this._lastRequestAt = 0;
  }

  async wait() {
    const target = this._lastRequestAt + this.minIntervalMs + this.jitterMs * this._random();
    const delay = target - Date.now();
    if (delay > 0) await this._sleep(delay);
  }

  mark() {
    this._lastRequestAt = Date.now();
    this.requestsMade += 1;
  }

  sleep(ms) {
    return this._sleep(ms);
  }

  backoffMs(attempt) {
    return Math.min(90000, 8000 * 2 ** attempt) + this._random() * 3000;
  }
}

export function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function retryAfterMs(headers) {
  const raw = headers?.get?.("Retry-After");
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * Is this response an anti-bot challenge rather than a plain error?
 * (DataDome serves 403 with a geo.captcha-delivery.com body to leboncoin.)
 */
export function looksLikeChallenge(status, body, headers) {
  if (![403, 429, 503].includes(status)) return false;
  const text = String(body || "").slice(0, 2000).toLowerCase();
  return (
    text.includes("captcha-delivery") ||
    text.includes("datadome") ||
    text.includes("captcha") ||
    text.includes("blocked") ||
    Boolean(headers?.get?.("x-datadome"))
  );
}
