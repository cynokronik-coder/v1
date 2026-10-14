/**
 * Make a marketplace request *from one of the user's own marketplace tabs*.
 *
 * Why this exists: a fetch from the extension's service worker goes out with
 * `Origin: chrome-extension://...` and `Sec-Fetch-Site: cross-site`. That is a
 * signal no marketplace client ever sends, and it is exactly what DataDome keyed
 * on for leboncoin: the worker's requests were challenged while the same search
 * worked from a normal tab.
 *
 * This transport closes that gap honestly. It does not forge a user agent, rotate
 * a proxy or solve a CAPTCHA: it asks a tab the user already has open (logged in,
 * warm session, same origin) to perform the request in its own page context. If no
 * such tab is open, it says so instead of pretending.
 *
 * The injected function is deliberately tiny and self-contained: MV3 runs it in
 * the page, so it cannot close over anything from this module.
 */

import { MarketplaceError } from "./adapters/base.js";

/** Runs in the page. Keep it self-contained: no imports, no closures. */
async function inPageFetch(url, init) {
  try {
    const response = await fetch(url, {
      credentials: "include",
      redirect: "follow",
      ...(init || {}),
    });
    const body = await response.text();
    return {
      ok: true,
      status: response.status,
      url: response.url,
      contentType: response.headers.get("content-type"),
      body,
    };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/** Runs in the page: hand back the document the user is looking at. Self-contained. */
function inPageDocument() {
  return {
    ok: true,
    url: location.href,
    title: document.title,
    html: document.documentElement.outerHTML,
  };
}

export class TabUnavailableError extends MarketplaceError {
  constructor(message) {
    super(message);
    this.name = "TabUnavailableError";
  }
}

/**
 * @param {object} options
 * @param {object} options.chrome  the extension API (tabs + scripting)
 * @param {(msg: string) => void} [options.logger]
 * @param {number} [options.timeoutMs]  how long to wait for the injected fetch
 */
export function createTabTransport({ chrome, logger = () => {}, timeoutMs = 25000 } = {}) {
  if (!chrome?.tabs || !chrome?.scripting) {
    throw new MarketplaceError("createTabTransport needs the tabs and scripting APIs");
  }

  /** Is there a tab open on one of these hosts? `www.example.fr` and `example.fr` match both. */
  async function tabsFor(hosts) {
    const patterns = new Set();
    for (const host of hosts || []) {
      const clean = String(host || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (!clean) continue;
      patterns.add(`https://${clean}/*`);
      if (clean.startsWith("www.")) patterns.add(`https://${clean.slice(4)}/*`);
      else patterns.add(`https://www.${clean}/*`);
    }
    const found = [];
    for (const url of patterns) {
      try {
        const tabs = await chrome.tabs.query({ url });
        for (const tab of tabs || []) {
          // A discarded tab has no live document to run in.
          if (tab && tab.id !== undefined && tab.id !== null && !tab.discarded) found.push(tab);
        }
      } catch (err) {
        logger(`tab lookup failed for ${url}: ${err.message || err}`);
      }
    }
    return found;
  }

  async function available(hosts) {
    return (await tabsFor(hosts)).length > 0;
  }

  /**
   * Perform `fetch(url, init)` inside a matching tab.
   * Returns the same {status, body, headers} shape every adapter consumes.
   */
  async function fetchInTab(url, init = {}, { hosts = [] } = {}) {
    const target = String(url);
    if (!/^https:\/\//.test(target)) {
      throw new TabUnavailableError(`refusing to run ${target} from a tab (only https is allowed)`);
    }
    const host = new URL(target).hostname;
    // The tab must be on the marketplace we are about to talk to: running the
    // request anywhere else would send the wrong Origin and prove nothing.
    const candidates = await tabsFor([host, ...(hosts || [])]);
    if (!candidates.length) {
      throw new TabUnavailableError(
        `no open tab on ${host} - open ${host} in a normal tab and retry, then the request is made from that tab's own session`,
      );
    }

    const problems = [];
    for (const tab of candidates.slice(0, 3)) {
      try {
        const results = await withTimeout(
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: inPageFetch,
            args: [target, init],
          }),
          timeoutMs,
          `the ${host} tab did not answer within ${Math.round(timeoutMs / 1000)}s`,
        );
        const result = results?.[0]?.result;
        if (!result) {
          problems.push(`tab ${tab.id} returned nothing`);
          continue;
        }
        if (result.ok === false) {
          // A *page-side* failure is a real answer (CORS, offline, redirect): report it.
          throw new MarketplaceError(`${target} failed inside the page: ${result.error}`);
        }
        logger(`tab transport: ${init.method || "GET"} ${target} via tab ${tab.id} -> HTTP ${result.status}`);
        return {
          status: result.status,
          body: result.body ?? "",
          url: result.url || target,
          headers: new Headers(result.contentType ? { "content-type": result.contentType } : {}),
        };
      } catch (err) {
        if (err instanceof MarketplaceError && !(err instanceof TabUnavailableError)) throw err;
        problems.push(`tab ${tab.id}: ${err.message || err}`);
      }
    }
    throw new TabUnavailableError(
      `could not run the request in any open tab (${problems.join("; ")})`,
    );
  }

  /**
   * Read the document of the first matching tab - the page the user is already on.
   *
   * This is the honest way to read a site whose search is client-rendered and whose
   * URL we cannot rely on: we build no URL, we make no request, we just read what
   * the site already served to that tab. `hosts` are the sites we accept here.
   */
  async function readTabDocument({ hosts = [] } = {}) {
    const candidates = await tabsFor(hosts);
    if (!candidates.length) {
      throw new TabUnavailableError(
        `no open tab on ${hosts.join(" or ")} - open the site, run the search yourself, then scan again`,
      );
    }
    const problems = [];
    for (const tab of candidates.slice(0, 3)) {
      try {
        const results = await withTimeout(
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: inPageDocument,
          }),
          timeoutMs,
          `the tab did not hand back its page within ${Math.round(timeoutMs / 1000)}s`,
        );
        const result = results?.[0]?.result;
        if (!result?.html) {
          problems.push(`tab ${tab.id} returned no document`);
          continue;
        }
        logger(`tab transport: read ${result.url} from tab ${tab.id} (${result.html.length} bytes)`);
        return {
          status: 200,
          body: result.html,
          url: result.url,
          tabId: tab.id,
          headers: new Headers({ "content-type": "text/html" }),
        };
      } catch (err) {
        problems.push(`tab ${tab.id}: ${err.message || err}`);
      }
    }
    throw new TabUnavailableError(`could not read any open tab (${problems.join("; ")})`);
  }

  return { available, fetchInTab, readTabDocument, tabsFor, timeoutMs };
}

/** Exposed for the unit tests: the functions that run inside the page. */
export const __inPageFetch = inPageFetch;
export const __inPageDocument = inPageDocument;

/** Reject after `ms`, so a hung page-side fetch cannot hang a whole scan. */
export function withTimeout(promise, ms, message = "timed out") {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}
