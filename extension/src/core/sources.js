/**
 * Where the numbers come from.
 *
 * One registry, because "which marketplaces does this thing actually cover, and
 * am I allowed to point it at them?" should be answerable by reading one file
 * instead of by grepping five adapters.
 *
 * The honest starting point, established by reading each site's own developer
 * material rather than assuming:
 *
 *   - **eBay** is the only one of these with a documented *search* API a
 *     hobbyist can reach: a free developer keyset is enough, no seller account,
 *     and Browse can return fixed-price used listings. eBay's Buy API
 *     requirements still say production use is intended for partners and needs
 *     approval, and sold-price history (Marketplace Insights) is limited-release
 *     and closed to new users - so this extension quotes *asking* prices, never
 *     "sold for". https://developer.ebay.com/api-docs/buy/static/buy-requirements.html
 *   - **Vinted** (https://pro-docs.svc.vinted.com/), **leboncoin**
 *     (https://leboncoinsolutionspro.fr/), **Back Market**
 *     (https://www.backmarket.com/en-us/seller/home), **Cdiscount/Octopia**
 *     (https://developer.octopia-io.net/home/) and **Fnac/Mirakl**
 *     (https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3)
 *     all document *seller*-side APIs only: publishing your own offers, orders,
 *     stock. None publishes a keyword-search API for other people's listings.
 *   - **Easy Cash, Cash Express, Cash Converters, Momox** publish no developer API
 *     at all that could be found.
 *   - **Facebook Marketplace** has an official listing API, but it is a partner
 *     program or the institution-only Meta Content Library, and Meta's terms
 *     forbid automated collection without permission.
 *   - **Rakuten France** is deliberately absent: Rakuten's own page says its
 *     French marketplace ceased activity on 30 September 2026.
 *
 * So a ten-marketplace tool cannot honestly be ten APIs. It is two documented
 * APIs (eBay; plus a third-party data provider if you bring a key) and a set of
 * pages the extension reads *in a tab you already have open*, at a slow pace,
 * with no user-agent spoofing, no proxy rotation and no CAPTCHA solving. Where a
 * site's search is client-side and its URL cannot be relied on, the default mode
 * is `open-tab`: you run the search yourself, the extension reads the results you
 * are looking at. That is a real feature, not a downgrade - it never touches a
 * URL the site did not already serve you.
 *
 * Every source below carries its terms status, so the UI can say which ones are
 * contractually fine and which ones are personal-use-only.
 */

/**
 * Kept dependency-free on purpose: models.js, catalog.js and the adapters all import
 * from this file, so it must not import back. Cycles in ESM are a foot-gun, not a style
 * choice.
 */
export class SourceError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceError";
  }
}

/** How the extension gets at a source's listings. */
export const ACCESS = {
  /** A documented API, used with the user's own key. */
  API: "official-api",
  /** The page, fetched by the extension (preferably inside the user's own tab). */
  PAGE: "page",
};

/** Where the request URL comes from. */
export const MODE = {
  /** A documented API endpoint. */
  API: "api",
  /** A search URL the extension builds from a template. */
  SEARCH_URL: "search-url",
  /** Whatever the user's own tab is showing: the extension builds no URL at all. */
  OPEN_TAB: "open-tab",
};

export const TERMS = {
  /** The site documents this path and it needs a key that identifies the caller. */
  DOCUMENTED: "documented",
  /** No public search API; the site's terms forbid or do not authorise automation. */
  UNOFFICIAL: "unofficial",
  /** The site's terms explicitly forbid automated collection. Off unless you opt in. */
  PROHIBITED: "prohibited",
};

const FAST = { minIntervalMs: 6000, jitterMs: 3000 };
const SLOW = { minIntervalMs: 9000, jitterMs: 4000 };
const SLOWER = { minIntervalMs: 12000, jitterMs: 5000 };

/**
 * The marketplaces. `buying: true` means it can back a watch / acquisition side;
 * `resale: true` means it can provide the resale reference for a product.
 */
export const SOURCES = [
  {
    id: "vinted",
    label: "Vinted",
    country: "FR",
    kind: "marketplace",
    side: "both",
    access: ACCESS.PAGE,
    mode: MODE.SEARCH_URL,
    hosts: ["www.vinted.fr", "vinted.fr"],
    searchUrl: "https://www.vinted.fr/catalog?search_text={query}",
    searchHint: "https://www.vinted.fr/catalog?search_text={query}",
    terms: TERMS.UNOFFICIAL,
    buying: true,
    resale: true,
    enabled: true,
    pacing: FAST,
    credentials: null,
    note:
      "Private sellers, the cheapest buy side for clothes, phones and consoles. Uses the " +
      "same catalog endpoint its own web app calls, through your session and its anon cookie.",
    termsNote:
      "Vinted's terms prohibit bots, scraping and crawlers unless Vinted permits them, and " +
      "its Pro API is allowlisted to approved businesses. Personal, low-volume research only.",
    advice:
      "Vinted rate-limits aggressively: keep the interval at 15 minutes or more, and open " +
      "vinted.fr in a tab so the request runs inside your own warm session.",
  },
  {
    id: "leboncoin",
    label: "leboncoin",
    country: "FR",
    kind: "marketplace",
    side: "both",
    access: ACCESS.PAGE,
    mode: MODE.SEARCH_URL,
    hosts: ["www.leboncoin.fr", "leboncoin.fr"],
    searchUrl: "https://www.leboncoin.fr/recherche?text={query}",
    searchHint: "https://www.leboncoin.fr/recherche?text={query}",
    terms: TERMS.UNOFFICIAL,
    buying: true,
    resale: true,
    enabled: true,
    pacing: SLOW,
    credentials: null,
    note:
      "The biggest French classifieds market for local pickups: furniture, tools, bikes, " +
      "consoles. Its search is server-rendered, and the extension prefers your open tab.",
    termsNote:
      "leboncoin publishes a professional seller API only, and its robots.txt asks search " +
      "robots and other automatic methods not to crawl. Low-volume personal use only.",
    advice:
      "leboncoin sits behind DataDome. Open leboncoin.fr in a normal tab and the extension " +
      "will borrow that session; it never solves a CAPTCHA or hides who it is.",
  },
  {
    id: "ebay",
    label: "eBay (Browse API)",
    country: "FR",
    kind: "marketplace",
    side: "both",
    access: ACCESS.API,
    mode: MODE.API,
    hosts: ["www.ebay.fr", "www.ebay.com"],
    searchUrl: "https://www.ebay.fr/sch/i.html?_nkw={query}",
    searchHint: "https://www.ebay.fr/sch/i.html?_nkw={query}",
    terms: TERMS.DOCUMENTED,
    buying: true,
    resale: true,
    enabled: true,
    pacing: { minIntervalMs: 4000, jitterMs: 1500 },
    credentials: {
      label: "eBay developer keyset",
      docsUrl: "https://developer.ebay.com/signin",
      keys: [
        { key: "ebayClientId", label: "Client ID (App ID)", type: "text" },
        { key: "ebayClientSecret", label: "Client Secret (Cert ID)", type: "password" },
        {
          key: "ebayMarketplaceId",
          label: "marketplace id",
          type: "text",
          required: false,
          note: "EBAY_FR, EBAY_DE, EBAY_GB... defaults to EBAY_FR",
        },
      ],
      note:
        "Free developer account, no seller account and no listing fees: a member account and a " +
        "keyset are what the Browse API asks for. Keys are stored locally and sent only to eBay.",
    },
    note:
      "The terms-compliant, documented path - and the preferred resale reference, because it " +
      "returns real asking prices for used and refurbished stock. It quotes asking prices: " +
      "sold-price history (Marketplace Insights) is limited-release and not open to new users.",
    termsNote:
      "Documented API under eBay's developer terms. Production use beyond development is " +
      "intended for eBay partners and needs approval, so treat this as a personal keyset.",
    advice:
      "Paste your Client ID and Client Secret in Settings. If eBay answers HTTP 401/403, check " +
      "that the Browse API scope is enabled on that keyset.",
  },
  {
    id: "backmarket",
    label: "Back Market",
    country: "FR",
    kind: "refurb",
    side: "resale",
    access: ACCESS.PAGE,
    mode: MODE.SEARCH_URL,
    hosts: ["www.backmarket.fr", "www.backmarket.com"],
    searchUrl: "https://www.backmarket.fr/fr-fr/search?q={query}",
    searchHint: "https://www.backmarket.fr/fr-fr/search?q={query}",
    terms: TERMS.UNOFFICIAL,
    buying: true,
    resale: true,
    enabled: true,
    pacing: SLOW,
    credentials: null,
    note:
      "Two different numbers live here, and the higher one is the one a search returns: what a " +
      "BUYER is charged, before Back Market's own commission (11% by default, 12% on phones sold " +
      "in France, 15-20% on accessories) - a ceiling, not a payout. Its trade-in flow separately " +
      "quotes what a refurbisher pays YOU, which is lower; both are read from the page and " +
      "neither is invented.",
    termsNote:
      "Back Market documents a seller API only. Personal, low-volume use of its public search " +
      "and buyback pages from your own session.",
    advice:
      "Open backmarket.fr in a tab so the request runs in that session. If Back Market changes " +
      "its markup, set a manual resale price on the product instead - the run still works. " +
      "Remember the commission: an asking price of 310 EUR on a phone nets about 272 EUR once " +
      "Back Market has taken its 12%.",
  },
  {
    id: "fnac",
    label: "Fnac (occasion & marketplace)",
    country: "FR",
    kind: "marketplace",
    side: "resale",
    access: ACCESS.PAGE,
    mode: MODE.SEARCH_URL,
    hosts: ["www.fnac.com"],
    searchUrl: "https://www.fnac.com/SearchResult/ResultList.aspx?Search={query}",
    searchHint: "https://www.fnac.com/SearchResult/ResultList.aspx?Search={query}",
    terms: TERMS.UNOFFICIAL,
    buying: true,
    resale: true,
    enabled: true,
    pacing: SLOW,
    credentials: null,
    note:
      "A resale reference for consumer electronics, cameras and audio: Fnac's own marketplace " +
      "sits next to retail prices, so it is a good proxy for what a buyer will pay.",
    termsNote:
      "Fnac's marketplace runs on Mirakl, whose documented API is the seller-side one. This " +
      "reads the public search page from your own browser session.",
    advice:
      "Fnac serves 403 to plain server requests. Open fnac.com in a tab, then run again - or " +
      "switch this source to 'open-tab' in the Marketplaces page and read the page you are on.",
  },
  {
    id: "cdiscount",
    label: "Cdiscount",
    country: "FR",
    kind: "marketplace",
    side: "resale",
    access: ACCESS.PAGE,
    mode: MODE.SEARCH_URL,
    hosts: ["www.cdiscount.com"],
    searchUrl: "https://www.cdiscount.com/search/10/{query}.html",
    searchHint: "https://www.cdiscount.com/search/10/{query}.html",
    terms: TERMS.UNOFFICIAL,
    buying: true,
    resale: true,
    enabled: true,
    pacing: SLOW,
    credentials: null,
    note:
      "Wide consumer-electronics catalogue with a large second-hand/marketplace section: useful " +
      "as a second resale opinion next to eBay and Back Market.",
    termsNote:
      "Cdiscount documents seller APIs through Octopia (its own offers, orders, logistics), not " +
      "a public search API. Personal, low-volume use of the public page.",
    advice: "Cdiscount's results load client-side. Open a Cdiscount search in a tab and use 'open-tab' mode.",
  },
  {
    id: "easycash",
    label: "Easy Cash",
    country: "FR",
    kind: "chain-shop",
    side: "both",
    access: ACCESS.PAGE,
    mode: MODE.OPEN_TAB,
    hosts: ["www.easycash.fr", "bons-plans.easycash.fr"],
    searchUrl: null,
    searchHint: "https://bons-plans.easycash.fr/",
    terms: TERMS.UNOFFICIAL,
    buying: true,
    resale: true,
    enabled: true,
    pacing: SLOWER,
    credentials: null,
    note:
      "The buy-back chain's own store: it publishes what it sells its bought stock for, which " +
      "is a firm second-hand retail price. No public API and no reliable keyword URL, so this " +
      "reads the page you have open.",
    termsNote:
      "No documented API. Personal, low-volume use of pages your own browser loads.",
    advice:
      "Open an Easy Cash search (or category) page in a tab, leave it open, then run. Paste a " +
      "working search URL template in the Marketplaces page to switch this to automatic mode.",
  },
  {
    id: "cashexpress",
    label: "Cash Express",
    country: "FR",
    kind: "chain-shop",
    side: "both",
    access: ACCESS.PAGE,
    mode: MODE.OPEN_TAB,
    hosts: ["www.cashexpress.fr"],
    searchUrl: null,
    searchHint: "https://www.cashexpress.fr/",
    terms: TERMS.UNOFFICIAL,
    buying: true,
    resale: true,
    enabled: true,
    pacing: SLOWER,
    credentials: null,
    note:
      "Second buy-back chain shop, per-store stock. Same treatment as Easy Cash: it reads the " +
      "results page you are looking at, so what you see is what gets measured.",
    termsNote: "No documented API. Personal, low-volume use of pages your own browser loads.",
    advice: "Open a Cash Express results page in a tab, then run.",
  },
  {
    id: "cashconverters",
    label: "Cash Converters",
    country: "FR",
    kind: "chain-shop",
    side: "both",
    access: ACCESS.PAGE,
    mode: MODE.OPEN_TAB,
    hosts: ["www.cashconverters.fr"],
    searchUrl: null,
    searchHint: "https://www.cashconverters.fr/",
    terms: TERMS.UNOFFICIAL,
    buying: true,
    resale: true,
    enabled: true,
    pacing: SLOWER,
    credentials: null,
    note:
      "Buy-back chain with an online catalogue. Its storefront loads results client-side, so the " +
      "extension reads the rendered page instead of guessing an endpoint.",
    termsNote: "No documented API. Personal, low-volume use of pages your own browser loads.",
    advice: "Open a Cash Converters results page in a tab, then run - the rendered page is what gets read.",
  },
  {
    id: "momox",
    label: "momox (shop & buy-back)",
    country: "FR",
    kind: "refurb",
    side: "resale",
    access: ACCESS.PAGE,
    mode: MODE.OPEN_TAB,
    hosts: ["www.momox-shop.fr", "www.momox.fr"],
    searchUrl: null,
    searchHint: "https://www.momox-shop.fr/",
    terms: TERMS.UNOFFICIAL,
    buying: true,
    resale: true,
    enabled: true,
    pacing: SLOWER,
    credentials: null,
    note:
      "Media and electronics specialist (books, games, phones). Its retail prices are a hard " +
      "floor for resale - if momox sells it for X, nobody pays you more than X.",
    termsNote: "No documented API. Personal, low-volume use of pages your own browser loads.",
    advice: "Open a momox search page in a tab and run. momox answers 403 to plain server requests.",
  },
  {
    id: "facebook",
    label: "Facebook Marketplace",
    country: "FR",
    kind: "social",
    side: "buy",
    access: ACCESS.PAGE,
    mode: MODE.OPEN_TAB,
    hosts: ["www.facebook.com"],
    searchUrl: null,
    searchHint: "https://www.facebook.com/marketplace/search/?query={query}",
    terms: TERMS.PROHIBITED,
    buying: true,
    resale: false,
    // Off until the user turns it on: Meta's terms forbid automated collection
    // without permission, and this is the one source where that is explicit.
    enabled: false,
    pacing: SLOWER,
    credentials: null,
    note:
      "Local pickups, often the cheapest source of furniture, bikes and tools. You must be " +
      "signed in; the extension reads the Marketplace page your own logged-in tab is showing.",
    termsNote:
      "Meta's terms forbid accessing or collecting data from its products by automated means " +
      "without prior permission, and its Marketplace listing API is partner-only. This is the " +
      "one source that is off by default and stays your call.",
    advice:
      "Open Facebook Marketplace in a tab, search there yourself, then run. Off by default: " +
      "read the terms note in Settings before enabling it.",
  },
  {
    id: "mock",
    label: "Offline demo",
    country: "-",
    kind: "fixture",
    side: "both",
    access: ACCESS.API,
    mode: MODE.API,
    hosts: [],
    searchUrl: null,
    searchHint: "",
    terms: TERMS.DOCUMENTED,
    buying: true,
    resale: true,
    enabled: true,
    pacing: FAST,
    credentials: null,
    note: "A deterministic fake marketplace, so the whole pipeline can be demonstrated with no network.",
    termsNote: "Nothing leaves your machine.",
    advice: "",
  },
];

export const SOURCE_IDS = SOURCES.map((source) => source.id);

/** Sources that can back a watch (the acquisition side). */
export const BUY_SOURCES = SOURCES.filter((source) => source.buying).map((source) => source.id);
/** Sources that can price the sell side of an opportunity. */
export const RESALE_REFERENCE_SOURCES = SOURCES.filter((source) => source.resale).map((source) => source.id);

/** Sources read out of a page rather than through a documented API. */
export const PAGE_SOURCE_IDS = SOURCES.filter((source) => source.access === ACCESS.PAGE).map((source) => source.id);

/** Sources whose terms are not a documented API: these need acknowledging first. */
export const UNOFFICIAL_SOURCE_IDS = SOURCES.filter((source) => source.terms !== TERMS.DOCUMENTED).map(
  (source) => source.id,
);

export function sourceById(id) {
  const key = String(id || "").trim().toLowerCase();
  const alias = key === "lbc" ? "leboncoin" : key === "back_market" ? "backmarket" : key === "fixture" ? "mock" : key;
  return SOURCES.find((source) => source.id === alias) || null;
}

export function isKnownSource(id) {
  return sourceById(id) !== null;
}

/** Unknown ids are rejected rather than silently scanned by name. */
export function assertKnownSource(id, where = "source") {
  const source = sourceById(id);
  if (!source) {
    throw new SourceError(`unknown ${where} '${id}' (expected one of: ${SOURCE_IDS.join(" | ")})`);
  }
  return source;
}

/**
 * One source's user settings: `settings.sources[<id>] = { enabled, mode, urlTemplate,
 * acknowledgeTerms }`. Everything about a source that the user can change lives in
 * that one object, so the Marketplaces page is a loop over the registry rather than a
 * pile of bespoke fields.
 */
export function sourceConfig(id, settings = {}) {
  const source = sourceById(id);
  return (source && settings?.sources?.[source.id]) || {};
}

/** Off only when the user turned it off, or the registry ships it off. */
export function sourceEnabled(id, settings = {}) {
  const source = sourceById(id);
  if (!source) return false;
  const configured = sourceConfig(source.id, settings).enabled;
  if (configured !== undefined) return Boolean(configured);
  return source.enabled !== false;
}

/** The search URL for a source, honouring a template the user edited in the UI. */
export function searchUrlFor(id, query, settings = {}) {
  const source = assertKnownSource(id);
  const template = sourceConfig(source.id, settings).urlTemplate || source.searchUrl;
  if (!template) return null;
  const text = String(query ?? "").trim();
  if (!text) return template.replace("{query}", "");
  return template.replace("{query}", encodeURIComponent(text));
}

/** `search-url` when the source has a usable template, else `open-tab`. */
export function modeFor(id, settings = {}) {
  const source = assertKnownSource(id);
  const requested = sourceConfig(source.id, settings).mode;
  if (requested && requested !== "auto") return requested;
  if (source.mode === MODE.API) return MODE.API;
  if (source.mode === MODE.OPEN_TAB) {
    return sourceConfig(source.id, settings).urlTemplate ? MODE.SEARCH_URL : MODE.OPEN_TAB;
  }
  return MODE.SEARCH_URL;
}

/** The site the extension should look for an open tab on (and use to resolve links). */
export function hostFor(id) {
  return sourceById(id)?.hosts?.[0] || null;
}

export function accessFor(id) {
  return sourceById(id)?.access || null;
}

export function labelFor(id) {
  return sourceById(id)?.label || String(id || "");
}

/** What to tell the user when this source fails; empty when there is nothing to say. */
export function adviceFor(id) {
  return sourceById(id)?.advice || "";
}

/** A URL the user can open themselves, with the keyword filled in where there is one. */
export function searchHintFor(id, query = "") {
  const source = sourceById(id);
  if (!source?.searchHint) return null;
  return source.searchHint.replace("{query}", encodeURIComponent(String(query || "").trim()));
}

/** Which credential keys a source needs, in the order the UI should show them. */
export function credentialKeysFor(id) {
  const source = sourceById(id);
  return source?.credentials?.keys?.map((entry) => entry.key) || [];
}

/** Only the keys with no sensible default: an empty marketplace id is not a blocker. */
export function requiredCredentialKeysFor(id) {
  const source = sourceById(id);
  return (source?.credentials?.keys || []).filter((entry) => entry.required !== false).map((entry) => entry.key);
}

/** Is this source fully configured for the given settings? */
export function sourceReady(id, settings = {}) {
  const source = sourceById(id);
  if (!source) return false;
  return requiredCredentialKeysFor(source.id).every((key) => Boolean(settings?.[key]));
}

/**
 * What to say about one source in the UI and in the self-check: everything the
 * extension actually knows, with no optimism.
 */
export function describeSource(id, { settings = {}, tabOpen = null, acknowledgeAll = false } = {}) {
  const source = sourceById(id);
  if (!source) return { id, label: String(id), status: "unknown", detail: "not a known source", source: null };
  const mode = modeFor(source.id, settings);
  const needsKeys = requiredCredentialKeysFor(source.id);
  const missing = needsKeys.filter((key) => !settings[key]);
  const acknowledged = acknowledgeAll || sourceConfig(source.id, settings).acknowledgeTerms === true;

  let status = "ready";
  let detail = source.note;
  if (source.mode === MODE.API && missing.length) {
    status = "needs credentials";
    detail = source.credentials?.note || `${source.label} needs ${missing.join(", ")}`;
  } else if (source.terms === TERMS.PROHIBITED && !acknowledged) {
    status = "off (terms)";
    detail = source.termsNote;
  } else if (mode === MODE.OPEN_TAB && tabOpen === false) {
    status = "needs an open tab";
    detail = source.advice || `Open ${source.hosts[0]} in a tab, then run again.`;
  } else if (mode === MODE.OPEN_TAB) {
    status = "reads your tab";
    detail = source.advice || `The extension reads the ${source.hosts[0]} page you have open.`;
  } else if (tabOpen === true && source.access === ACCESS.PAGE) {
    status = "ready (your tab)";
    detail = `${source.label}: requests are made by your own open tab, at ${Math.round(source.pacing.minIntervalMs / 1000)}s intervals.`;
  }
  return { id: source.id, label: source.label, status, detail, source, mode, missing };
}

/** Grouped for the Marketplaces page, so the UI never hard-codes this list. */
export function sourcesByKind() {
  const groups = new Map();
  for (const source of SOURCES) {
    if (!groups.has(source.kind)) groups.set(source.kind, []);
    groups.get(source.kind).push(source.id);
  }
  return [...groups.entries()].map(([kind, ids]) => ({ kind, ids }));
}

// --- third-party data providers ---------------------------------------------

/**
 * The "connect a web tool" question, answered the way it actually works: you
 * bring a key for a data vendor, the extension calls it from the service worker
 * and normalises what comes back. These are not marketplaces - each one is a
 * documented API that either returns listings for a keyword or a resale price,
 * including for the sites above that have no API of their own.
 *
 * The trade is explicit: the vendor scrapes, at their scale, under their
 * compliance programme, and you pay them. That does not make a source's terms
 * disappear, which is why each provider says what it covers and what it does not.
 */
export const PROVIDERS = [
  {
    id: "apify",
    label: "Apify",
    keySetting: "apifyToken",
    keys: [{ key: "apifyToken", label: "API token", type: "password" }],
    docsUrl: "https://docs.apify.com/api/v2",
    signupUrl: "https://console.apify.com/sign-up",
    freeTier: "free plan with monthly usage credit; actors bill per 1,000 results",
    covers: ["vinted", "leboncoin", "facebook", "easycash", "cashexpress", "cashconverters", "momox"],
    what:
      "Runs one of the marketplace scrapers ('actors') in its store and returns the dataset as " +
      "JSON. The actor id is configurable per source, so you choose whose scraper you trust.",
    legal:
      "Apify's store is not an authorisation layer: using an actor does not make collection " +
      "compliant with the marketplace's own terms. Prefer actors you have a licence for.",
    usage: "listings",
  },
  {
    id: "serpapi",
    label: "SerpApi",
    keySetting: "serpApiKey",
    keys: [{ key: "serpApiKey", label: "API key", type: "password" }],
    docsUrl: "https://serpapi.com/google-shopping-api",
    signupUrl: "https://serpapi.com/users/sign_up",
    freeTier: "250 searches/month free, then paid plans from around $25/month",
    covers: ["*"],
    what:
      "Google Shopping prices (a broad resale reference across every retailer) and Google Trends " +
      "interest-over-time, which is the closest thing to a real demand signal that has an API at all.",
    legal:
      "A third-party interface to Google data, not a Google-authorised API. Google's terms apply " +
      "to automated access; SerpApi markets its own compliance programme.",
    usage: "price+trends",
  },
  {
    id: "brightdata",
    label: "Bright Data",
    keySetting: "brightDataToken",
    keys: [
      { key: "brightDataToken", label: "API token", type: "password" },
      { key: "brightDataZone", label: "unlocker zone", type: "text", note: "the zone name in your dashboard" },
    ],
    docsUrl: "https://docs.brightdata.com/api-reference/Web_Unlocker/request",
    signupUrl: "https://brightdata.com/",
    freeTier: "free monthly records on its scraper products; pay-as-you-go after that",
    covers: ["vinted", "leboncoin", "facebook", "momox"],
    what:
      "Fetches a marketplace page from its own infrastructure and hands back the HTML, which the " +
      "extension parses with the same extractor it uses everywhere else. Useful when a site " +
      "refuses requests from your own network.",
    legal:
      "A proxy/unlocker service is not permission from the site. Bright Data markets GDPR/CCPA " +
      "compliance; the source platform's terms still apply to the data you collect.",
    usage: "page",
  },
  {
    id: "keepa",
    label: "Keepa (Amazon price history)",
    keySetting: "keepaKey",
    keys: [{ key: "keepaKey", label: "API key", type: "password" }],
    docsUrl: "https://keepa.com/api-docs/",
    signupUrl: "https://keepa.com/#!api",
    freeTier: "paid token buckets; there is a small free allowance for testing",
    covers: ["amazon"],
    what:
      "Amazon price and offer *history* by ASIN. Amazon is where a lot of refurbished stock is " +
      "actually sold, and Keepa is the documented way to see its price trend rather than today's " +
      "snapshot.",
    legal: "A licensed data product for Amazon marketplaces. No key, no data.",
    usage: "history",
  },
];

export const PROVIDER_IDS = PROVIDERS.map((provider) => provider.id);

export function providerById(id) {
  return PROVIDERS.find((provider) => provider.id === String(id || "").trim().toLowerCase()) || null;
}

export function providerKeysConfigured(settings = {}) {
  const out = {};
  for (const provider of PROVIDERS) out[provider.id] = provider.keys.every((entry) => Boolean(settings[entry.key]));
  return out;
}

/**
 * Providers that could return *listings* for a marketplace. A price/trends or
 * price-history provider is not one of them: Google Shopping cannot tell you what a
 * leboncoin seller is asking.
 */
export function providersForSource(id) {
  const source = sourceById(id);
  if (!source) return [];
  return PROVIDERS.filter(
    (provider) =>
      (provider.usage === "listings" || provider.usage === "page") &&
      (provider.covers.includes("*") || provider.covers.includes(source.id)),
  );
}
