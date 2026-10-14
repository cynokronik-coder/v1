/**
 * The generic adapter: one implementation, N marketplaces.
 *
 * Every marketplace in core/sources.js whose access is `page` is served by this
 * class. It exists because writing a bespoke scraper per site is how you end up
 * with eight files that are each slightly wrong - the differences between these
 * sites are *where to look*, not *what a listing is*.
 *
 * Two modes, and the difference matters:
 *
 *   `search-url`  the extension builds a search URL from the registry's template
 *                 (or one the user pasted) and fetches it - inside one of the
 *                 user's own tabs on that host when there is one, otherwise from
 *                 the service worker.
 *
 *   `open-tab`    the extension builds **no URL and makes no request**. It reads
 *                 the results page the user already has open. That is the default
 *                 for sites whose search is client-rendered and cannot be relied
 *                 on: what you see is what gets measured, and the site sees
 *                 nothing it did not already serve.
 *
 * Failure is always explicit. A challenge page, a login wall, a 404 on a template
 * that has gone stale, or an HTTP 200 with no recognisable product data all raise
 * an error that says which of those happened and what to do instead. It never
 * returns an empty list as if the market were empty, and it never invents a price.
 */

import { looksLikeLoginWall, parseSearchHtml } from "./html-extract.js";
import { Pacing, MarketplaceBlocked, MarketplaceError, looksLikeChallenge } from "./base.js";
import { MODE, adviceFor, hostFor, modeFor, searchUrlFor } from "../sources.js";

/** Best-effort domain for resolving relative links. */
function domainOf(source, override) {
  const raw = override || hostFor(source.id);
  return String(raw || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

export function createPageAdapter(source, options = {}) {
  const {
    fetchImpl,
    tabTransport = null,
    // The user's per-source settings (enabled, mode, urlTemplate, acknowledgeTerms).
    settings = {},
    mode: requestedMode = null,
    domain = null,
    currency = "EUR",
    condition = null,
    sleep,
    random,
    pacing,
    maxRetries = 1,
    logger = () => {},
  } = options;

  if (!fetchImpl) throw new MarketplaceError(`the ${source.id} adapter needs a fetch implementation`);
  const mode = requestedMode || modeFor(source.id, settings);
  const template = settings?.sources?.[source.id]?.urlTemplate || source.searchUrl;
  if (mode === MODE.SEARCH_URL && !template) {
    throw new MarketplaceError(`${source.label}: no search URL is configured. ${adviceFor(source.id)}`);
  }

  const resolvedDomain = domainOf(source, domain);
  const hosts = source.hosts?.length ? source.hosts : [resolvedDomain].filter(Boolean);

  const adapter = {
    name: source.id,
    label: source.label,
    mode,
    source,
    domain: resolvedDomain,
    hosts,
    requestsMade: 0,
    /** Which extraction strategy produced the listings (json-ld, embedded-json, markup). */
    lastSource: null,
    /** Who made the request: your open tab, the service worker, or nothing at all. */
    lastTransport: null,
    lastUrl: null,
    configured: true,

    async _hasTab() {
      if (typeof tabTransport?.available !== "function") return false;
      try {
        return Boolean(await tabTransport.available(hosts));
      } catch {
        return false;
      }
    },

    async _fetch(url) {
      if (typeof tabTransport?.fetchInTab === "function" && (await this._hasTab())) {
        this.lastTransport = "your open tab";
        try {
          return await tabTransport.fetchInTab(
            url,
            { credentials: "include", headers: { Accept: "text/html,application/xhtml+xml" } },
            { hosts },
          );
        } catch (err) {
          // A tab failure is worth reporting but not worth abandoning the request:
          // the service worker can still try (and will say so when it fails too).
          logger(`${source.id}: tab transport failed (${err?.message || err}), falling back to the worker`);
        }
      }
      this.lastTransport = "the service worker";
      try {
        return await fetchImpl(url, {
          credentials: "include",
          headers: { Accept: "text/html,application/xhtml+xml" },
        });
      } catch (err) {
        throw new MarketplaceError(`request to ${url} failed: ${err?.message || err}`);
      }
    },

    async _readOpenTab() {
      if (typeof tabTransport?.readTabDocument !== "function") {
        throw new MarketplaceError(
          `${source.label}: reading your open tab needs the scripting permission. ${adviceFor(source.id)}`,
        );
      }
      this.lastTransport = "your open tab";
      const response = await tabTransport.readTabDocument({ hosts });
      return response;
    },

    /** The URL this source would search, with the keyword filled in. */
    searchUrl(searchText) {
      return searchUrlFor(source.id, searchText, settings);
    },

    /** One request (or one tab read). Kept separate so it can be tested directly. */
    async _retrieve(query = {}) {
      if (mode === MODE.OPEN_TAB) return this._readOpenTab();
      const url = this.searchUrl(query.searchText);
      this.lastUrl = url;
      return this._fetch(url);
    },

    _parse(response) {
      const { items, source: strategy } = parseSearchHtml(response.body, {
        marketplace: source.id,
        domain: resolvedDomain,
        currency,
        condition,
      });
      return { items, strategy };
    },

    async search(query = {}) {
      const pacing = this.pacing || new Pacing({ ...source.pacing, sleep, random });
      let lastStatus = null;

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        await pacing.wait();
        const response = await this._retrieve(query);
        pacing.mark();
        this.requestsMade += 1;
        lastStatus = response.status;

        if (looksLikeChallenge(response.status, response.body, response.headers)) {
          throw new MarketplaceBlocked(
            `${source.label} refused the request (HTTP ${response.status}, bot protection). ${adviceFor(source.id)}`,
          );
        }
        if (response.status === 404 || response.status === 410) {
          throw new MarketplaceError(
            `${source.label} answered HTTP ${response.status} for ${this.lastUrl || "the search page"}: ` +
              "the search URL template in core/sources.js has probably gone stale. Open the site, run the " +
              "search yourself, and either paste the working URL into the Sources page or switch this source " +
              "to 'reads your tab'.",
          );
        }
        if (response.status >= 500 && attempt < maxRetries) {
          await pacing.sleep(pacing.backoffMs(attempt));
          continue;
        }
        if (response.status !== 200) {
          throw new MarketplaceError(`the ${source.label} request failed (HTTP ${response.status})`);
        }

        const { items, strategy } = this._parse(response);
        if (!items.length) {
          // A login wall looks exactly like "no results" until you read the page, and
          // the fix is completely different: sign in, rather than change the source.
          if (looksLikeLoginWall(response.body)) {
            throw new MarketplaceError(
              `${source.label} served a sign-in page instead of results. Sign in to ${source.hosts[0]} in a ` +
                "tab, run the search there, then use this source in 'reads your tab' mode.",
            );
          }
          const hint =
            mode === MODE.OPEN_TAB
              ? `the ${source.label} page you have open has no product data the extension recognises ` +
                "(run the search in that tab first, or scroll it so the results load), or the page's markup changed"
              : `HTTP 200 but no product data could be read from ${this.lastUrl} ` +
                "(the site may render its results client-side, or its markup changed). " +
                "Switch this source to 'reads your tab' and run the search yourself";
          throw new MarketplaceError(`${source.label}: ${hint}`);
        }
        this.lastSource = strategy;
        return this._result(items, query, strategy);
      }
      throw new MarketplaceError(`giving up on ${source.label} (last HTTP ${lastStatus})`);
    },

    _result(items, query, strategy) {
      const min = query.minPrice ?? null;
      const max = query.maxPrice ?? null;
      // Page sources cannot be trusted to honour a price band, so it is applied
      // here - after the fact, and only when the caller asked for one.
      const kept = items.filter(
        (item) => (min === null || item.price >= min) && (max === null || item.price <= max),
      );
      return {
        marketplace: source.id,
        items: kept,
        page: Math.max(1, query.page || 1),
        perPage: kept.length,
        // A scraped page gives no honest total: it is one page of results, and
        // pretending otherwise would corrupt the demand score.
        totalEntries: null,
        totalPages: null,
        strategy,
        mode,
        droppedByBand: items.length - kept.length,
      };
    },

    pacing: pacing || new Pacing({ ...source.pacing, sleep, random }),
  };

  return adapter;
}

export { MODE };
