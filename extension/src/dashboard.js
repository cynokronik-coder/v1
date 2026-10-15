/**
 * The dashboard.
 *
 * Everything that can be wrong quietly (filtering, formatting, form -> watch,
 * scoring) lives in src/ui/*.js and src/core/* and is tested in node; this file is
 * only the DOM wiring and the messages it sends to the service worker.
 *
 * One rule matters more than the rest, and it is the one that used to be broken:
 * **never rebuild an editor the user is typing into.** The dashboard polls the
 * worker every 5 s, and re-rendering the watch list from stored state on each poll
 * silently reverted whatever had just been typed, or unticked a checkbox that had
 * just been ticked (the form showed the saved watch, not the edited one). So the
 * editors are only rebuilt when the stored values actually changed, and never while
 * the form is dirty - plus the open/closed panels and the focused field are
 * restored when a rebuild does happen.
 */

import {
  countByStatus,
  dealHeadline,
  marketplaceLabel,
  marketplaceList,
  money,
  percent,
  relativeTime,
  untilTime,
  useSourceLabels,
  visibleDeals,
  watchSummary,
} from "./ui/format.js";
import {
  confidenceLine,
  historyRows,
  historySummary,
  historyWhen,
  lastRunLine,
  opportunityCategories,
  opportunityHeadline,
  pageCounts,
  priceSeries,
  resaleReference,
  scoreLine,
  sparklinePath,
  verdictLabel,
  visibleOpportunities,
} from "./ui/views.js";
import { blankWatchForm, formToWatch, watchToForm } from "./ui/watch-form.js";
import { unwrap } from "./core/messages.js";

const $ = (id) => document.getElementById(id);
const FILTERS_KEY = "marketwatch.filters";

/** Talk to the service worker, which may be asleep: sendMessage wakes it.
 *  Every reply is wrapped ({ok, result} / {ok, error}) - see src/core/messages.js. */
async function send(message) {
  return unwrap(await chrome.runtime.sendMessage(message));
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

let state = null;
let checks = null;
let scanning = false;
let opportunityScanning = false;
let page = "deals";
/** True while the user has edited a form the worker has not stored yet. */
let watchesDirty = false;
let catalogDirty = false;
let watchesSignature = null;
let catalogSignature = null;
let sourcesSignature = null;
/** True while the user is editing a source row the worker has not stored yet. */
let sourcesDirty = false;

const filters = {
  status: "new",
  watch: "",
  marketplace: "",
  text: "",
  minDiscount: "",
  sort: "newest",
  favourite: false,
  verdict: "",
  category: "",
  opportunityText: "",
  opportunitySort: "score",
  opportunityActionable: "",
  historyKind: "",
  historyWatch: "",
  historyText: "",
};

/** Filter on <select>/<input> values, which are strings. */
function activeFilters(over = {}) {
  return {
    ...filters,
    minDiscount: filters.minDiscount === "" ? null : Number(filters.minDiscount),
    ...over,
  };
}

function persistFilters() {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  } catch {
    /* private mode, or storage turned off: filters just will not stick */
  }
}

function restoreFilters() {
  try {
    Object.assign(filters, JSON.parse(localStorage.getItem(FILTERS_KEY) || "{}"));
  } catch {
    /* ignore a corrupt value */
  }
  const set = (id, value) => {
    const node = $(id);
    if (node) node.value = value ?? "";
  };
  set("filter-watch", filters.watch);
  set("filter-marketplace", filters.marketplace);
  set("filter-sort", filters.sort);
  set("filter-discount", filters.minDiscount);
  set("filter-text", filters.text);
  set("filter-verdict", filters.verdict);
  set("filter-category", filters.category);
  set("filter-opportunity-sort", filters.opportunitySort);
  set("filter-opportunity-text", filters.opportunityText);
  set("filter-opportunity-actionable", filters.opportunityActionable);
  set("filter-history-kind", filters.historyKind);
  set("filter-history-watch", filters.historyWatch);
  set("filter-history-text", filters.historyText);
  paintTabs();
}

function paintTabs() {
  for (const tab of document.querySelectorAll(".tab")) {
    const active = tab.dataset.favourites ? filters.favourite : !filters.favourite && tab.dataset.status === filters.status;
    tab.classList.toggle("is-active", Boolean(active));
  }
}

function toast(message, kind = "") {
  const banner = $("banner");
  banner.textContent = message;
  banner.className = `banner ${kind}`;
  banner.hidden = !message;
}

/**
 * Show one tool, hide the rest.
 *
 * The list of pages comes from the navigation itself, so a tool is added by adding a
 * nav button and a `<main>` - there is no second list to forget to update. (There
 * used to be one here, and it is exactly how the catalogue became unreachable: it
 * lived inside the Opportunities page, hidden behind a page nobody could get to.)
 */
function showPage(next) {
  const tabs = [...document.querySelectorAll(".pagenav-tab")];
  const wanted = tabs.some((tab) => tab.dataset.page === next) ? next : "deals";
  page = wanted;
  for (const tab of tabs) tab.classList.toggle("is-active", tab.dataset.page === wanted);
  for (const main of document.querySelectorAll("main[id^='page-']")) {
    main.hidden = main.id !== `page-${wanted}`;
  }
  // The sticky header names the tool you are in, so the rail does not have to be
  // read again every time a long page scrolls. The label comes from the nav button
  // itself (minus its count badge), so a renamed tool is renamed in one place.
  const active = tabs.find((tab) => tab.dataset.page === wanted);
  const crumb = $("crumb");
  if (active && crumb) {
    const label = active.cloneNode(true);
    label.querySelector(".pagenav-badge")?.remove();
    label.querySelector(".ico")?.remove();
    crumb.textContent = label.textContent.trim();
  }
}

/** The search URL the registry publishes for a marketplace, keyword filled in. */
function sourceSearchUrl(marketplace, keyword) {
  const source = (state?.sources || []).find((entry) => entry.id === marketplace);
  const hint = source?.searchHint || "";
  if (!hint.includes("{query}") || !keyword) return null;
  return hint.replace("{query}", encodeURIComponent(keyword));
}

async function refresh() {
  try {
    state = await send({ type: "getState" });
    // The registry dump is also what turns a marketplace id into a readable name.
    useSourceLabels(state);
    scanning = Boolean(state.scanning);
    opportunityScanning = Boolean(state.opportunityScanning);
  } catch (err) {
    toast(`could not read state: ${err.message}`, "bad");
    return;
  }
  render();
}

function render() {
  if (!state) return;
  renderStatus();
  renderDeals();
  renderWatches();
  renderMarkets();
  renderChecks();
  renderLog();
  renderOpportunities();
  renderCatalog();
  renderHistory();
  renderSources();
  renderProviders();
  renderApiSetup();
  renderPriceMarkets();
  renderSettings();
  renderBadges();
}

function renderBadges() {
  const counts = pageCounts({ alerts: state.alerts || [], opportunities: state.opportunities || [] });
  $("badge-deals").textContent = counts.deals ? String(counts.deals) : "";
  $("badge-opportunities").textContent = counts.opportunities ? String(counts.opportunities) : "";
  // The Sources badge counts what is *not* usable yet, because that is the only
  // number on this page that is worth acting on.
  const blocked = (state.sources || []).filter((source) => source.enabled && /needs|off \(terms\)/.test(source.status)).length;
  $("badge-sources").textContent = blocked ? String(blocked) : "";
}

// --- header ----------------------------------------------------------------

function renderStatus() {
  const run = Object.values(state.runs || {}).sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0))[0];
  const pill = $("pill-scan");
  pill.textContent = scanning ? "scanning..." : `last scan ${relativeTime(run?.at)}`;
  pill.classList.toggle("pill-live", scanning);
  $("pill-next").textContent = `next scan: ${untilTime(state.nextRunAt)}`;

  const counts = countByStatus(state.alerts || []);
  $("pill-counts").textContent = `${counts.new} new · ${state.watches.length} watch(es)`;
  const needsAck = (state.watches || []).filter((w) => !w.acknowledgeTerms && state.unofficialMarketplaces.includes(w.marketplace));
  const blocked = Object.values(state.runs || {}).find((r) => r.error === "blocked");

  if (needsAck.length) {
    toast(
      `${needsAck.map((w) => w.name).join(", ")}: ${marketplaceLabel(needsAck[0].marketplace)} has no public search API. ` +
        "Tick 'terms acknowledged' on the watch to accept personal, low-volume use - read the extension README first.",
      "",
    );
    return "acknowledge";
  }
  if (blocked) {
    toast(
      `${marketplaceLabel(blocked.marketplace || "")} refused a scan (${blocked.message || "blocked"}). ` +
        "Open that marketplace in a normal tab so the browser has a real session, then scan again - " +
        "with such a tab open the extension makes the request from it.",
      "bad",
    );
    return "blocked";
  }
  toast("");
  return null;
}

// --- deals -----------------------------------------------------------------

function dealCard(deal) {
  const node = $("deal-template").content.firstElementChild.cloneNode(true);
  node.classList.toggle("is-favourite", Boolean(deal.favourite));
  const shot = node.querySelector(".shot");
  const img = node.querySelector("img");
  shot.href = deal.url;
  if (deal.imageUrl) {
    img.src = deal.imageUrl;
    img.alt = deal.title || "";
    img.addEventListener("error", () => shot.classList.add("is-missing"));
  } else {
    shot.classList.add("is-missing");
  }

  node.querySelector(".chip-deal").textContent = `${percent(deal.discountPct)} under`;
  node.querySelector(".chip-watch").textContent = deal.watch;
  node.querySelector(".chip-market").textContent = marketplaceLabel(deal.marketplace);
  const statusChip = node.querySelector(".chip-status");
  if (deal.status !== "new") {
    statusChip.hidden = false;
    statusChip.textContent = deal.status;
  }
  node.querySelector(".chip-star").hidden = !deal.favourite;
  node.querySelector(".title").textContent = deal.title || "(untitled)";
  node.querySelector(".headline").textContent = dealHeadline(deal);

  const detail = [deal.brand, deal.size, deal.condition].filter(Boolean).join(" · ");
  node.querySelector(".detail").textContent = detail || "no brand/condition stated";
  node.querySelector(".reasons").textContent = (deal.reasons || []).join(", ");

  const open = node.querySelector("a.open");
  open.href = deal.url;
  const star = node.querySelector(".act-star");
  star.textContent = deal.favourite ? "★ Starred" : "☆ Star";
  star.classList.toggle("is-on", Boolean(deal.favourite));
  star.addEventListener("click", () => setFavourite(deal.key, !deal.favourite));
  node.querySelector(".act-bought").addEventListener("click", () => setStatus(deal.key, "bought"));
  node.querySelector(".act-hidden").addEventListener("click", () => setStatus(deal.key, "hidden"));
  node.querySelector(".act-new").addEventListener("click", () => setStatus(deal.key, "new"));
  if (deal.status !== "new") node.querySelector(".act-new").hidden = false;
  node.querySelector(".act-copy").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText(deal.url);
      button.textContent = "copied";
    } catch {
      // Clipboard access can be refused; the link is on the card either way.
      button.textContent = "copy failed - open it instead";
    }
    setTimeout(() => (button.textContent = "Copy link"), 1600);
  });
  return node;
}

function renderDeals() {
  const container = $("deals");
  const deals = visibleDeals(state.alerts || [], activeFilters());
  container.replaceChildren();
  const empty = $("deals-empty");

  if (!deals.length) {
    empty.hidden = false;
    empty.textContent = filters.favourite
      ? "No starred deals yet. Star one with the ☆ button and it stays here whatever its status."
      : state.watches.length
        ? "Nothing here yet. Deals appear when a scan finds a listing well below the market price."
        : "No watches yet - add one on the right, or try the offline demo to see how it looks.";
    return;
  }
  empty.hidden = true;
  for (const deal of deals) container.append(dealCard(deal));
}

async function setStatus(key, status) {
  await send({ type: "setDealStatus", key, status });
  await refresh();
}

async function setFavourite(key, favourite) {
  await send({ type: "setFavourite", key, favourite });
  await refresh();
}

// --- watches ---------------------------------------------------------------

function watchEditor(watch, index) {
  const form = watchToForm(watch);
  const run = state.runs?.[watch.name];
  const baseline = state.baselines?.[watch.name];
  const summary = watchSummary(run, baseline);

  const details = el("details", { class: "watch", ...(index === 0 ? { open: "open" } : {}) });
  details.dataset.name = watch.name;
  details.append(el("summary", {}, [el("span", { text: watch.name }), el("span", { class: "market-line", text: summary.line })]));

  const grid = el("div", { class: "grid2" }, [
    field("name", "name", form.name),
    selectField("marketplace", "marketplace", form.marketplace, MARKETPLACE_OPTIONS),
    el("div", { class: "full" }, [field("search text", "searchText", form.searchText)]),
    el("div", { class: "full check" }, [
      checkField("exact phrase: the listing must contain the whole search text, as consecutive words, in its title or description", "exactPhrase", form.exactPhrase),
    ]),
    field("min discount %", "minDiscount", form.minDiscount),
    field("max robust z (off to ignore)", "maxRobustZ", form.maxRobustZ),
    field("min sample size", "minSampleSize", form.minSampleSize),
    field("must match (comma separated regex)", "mustMatch", form.mustMatch),
    field("must not match", "mustNotMatch", form.mustNotMatch),
    field("sizes", "sizes", form.sizes),
    field("conditions", "conditions", form.conditions),
    field("plausible min price", "plausibleMinPrice", form.plausibleMinPrice),
    field("plausible max price", "plausibleMaxPrice", form.plausibleMaxPrice),
    field("sample pages", "samplePages", form.samplePages),
    checkField("enabled", "enabled", form.enabled),
  ]);

  if (state.unofficialMarketplaces.includes(watch.marketplace)) {
    grid.append(
      checkField(
        `${marketplaceLabel(watch.marketplace)}: I accept the terms (personal, low-volume use)`,
        "acknowledgeTerms",
        form.acknowledgeTerms,
      ),
    );
  }
  details.append(grid);
  details.append(el("button", { class: "btn remove", text: "Remove this watch", onclick: () => {
    details.remove();
    watchesDirty = true;
  } }));
  return details;
}

const MARKETPLACE_OPTIONS = [
  "vinted",
  "leboncoin",
  "ebay",
  "backmarket",
  "fnac",
  "cdiscount",
  "easycash",
  "cashexpress",
  "cashconverters",
  "momox",
  "facebook",
  "mock"
];

function field(label, name, value, { type = "text", placeholder = "" } = {}) {
  const input = el("input", { type, value: value ?? "", placeholder });
  input.dataset.field = name;
  return el("label", {}, [el("span", { text: label }), input]);
}

function selectField(label, name, value, options) {
  const select = el("select", {});
  select.dataset.field = name;
  for (const option of options) {
    select.append(el("option", { value: option, text: option, ...(option === value ? { selected: "selected" } : {}) }));
  }
  return el("label", {}, [el("span", { text: label }), select]);
}

function checkField(label, name, checked, title = "") {
  const input = el("input", { type: "checkbox", title });
  input.dataset.field = name;
  input.checked = checked;
  return el("label", { class: "check" }, [input, el("span", { text: label })]);
}

function signatureOf(items) {
  return JSON.stringify(items || []);
}

/** Which panels are open, and which field has the caret, so a rebuild is invisible. */
function captureEditorState() {
  const open = new Set();
  for (const node of document.querySelectorAll("details.watch")) if (node.open) open.add(node.dataset.name);
  const active = document.activeElement;
  const focus =
    active && active.dataset && active.dataset.field
      ? { field: active.dataset.field, name: active.closest("details.watch")?.dataset.name || null }
      : null;
  return { open, focus };
}

function restoreEditorState(snapshot) {
  if (!snapshot) return;
  for (const node of document.querySelectorAll("details.watch")) {
    if (snapshot.open.has(node.dataset.name)) node.open = true;
  }
  if (!snapshot.focus) return;
  for (const node of document.querySelectorAll("details.watch")) {
    if (snapshot.focus.name && node.dataset.name !== snapshot.focus.name) continue;
    const target = [...node.querySelectorAll("[data-field]")].find((input) => input.dataset.field === snapshot.focus.field);
    if (target) {
      target.focus();
      try {
        target.setSelectionRange?.(target.value.length, target.value.length);
      } catch {
        /* checkboxes have no selection range */
      }
      return;
    }
  }
}

function renderWatches({ force = false } = {}) {
  const box = $("watches");
  const hint = $("watches-hint");
  const signature = signatureOf(state.watches);
  // The fix for the "my edits keep disappearing" bug: while the form is dirty and
  // the stored watches have not changed, leave the DOM exactly as the user left it.
  if (!force && watchesDirty && signature === watchesSignature) return;

  const snapshot = captureEditorState();
  box.replaceChildren();
  if (!state.watches.length) {
    hint.textContent = "No watches. A watch is one product you want, on one marketplace.";
  } else {
    hint.textContent = `${state.watches.length} watch(es). Changes apply after "Save watches".`;
    state.watches.forEach((watch, index) => box.append(watchEditor(watch, index)));
  }
  watchesSignature = signature;
  watchesDirty = false;
  restoreEditorState(snapshot);
}

function readWatchForms() {
  const watches = [];
  for (const node of document.querySelectorAll("details.watch")) {
    const values = {};
    for (const input of node.querySelectorAll("[data-field]")) {
      values[input.dataset.field] = input.type === "checkbox" ? input.checked : input.value;
    }
    watches.push(formToWatch(values)); // throws ConfigError with a readable message
  }
  return watches;
}

async function saveWatches() {
  const error = $("watches-error");
  try {
    const watches = readWatchForms();
    const saved = await send({ type: "setWatches", watches });
    watchesDirty = false;
    toast(`saved ${saved.watches.length} watch(es)`, "good");
    error.hidden = true;
    error.textContent = "";
    await refresh();
    renderWatches({ force: true });
  } catch (err) {
    error.hidden = false;
    error.textContent = String(err.message || err).replace(/^Error: /, "");
    toast("");
  }
}

// --- markets, self-check, log ----------------------------------------------

function renderMarkets() {
  const box = $("markets");
  box.replaceChildren();
  if (!state.watches.length) {
    box.append(el("p", { class: "hint", text: "Add a watch to see what the market looks like." }));
    return;
  }
  for (const watch of state.watches) {
    const run = state.runs?.[watch.name];
    const baseline = state.baselines?.[watch.name];
    const summary = watchSummary(run, baseline);
    const stats = baseline?.stats;
    const market = el("div", { class: "market" }, [
      el("div", { class: "market-name" }, [
        el("span", { text: watch.name }),
        el("span", { class: "chip", text: marketplaceLabel(watch.marketplace) }),
        ...(watch.exactPhrase ? [el("span", { class: "chip", text: "exact phrase" })] : []),
      ]),
      el("div", { class: "market-line", text: summary.line }),
      el("div", {
        class: "market-line",
        text:
          `median ${money(stats?.median, stats?.currency)} · spread ${money(stats?.mad, stats?.currency)} · ` +
          `kept ${stats?.usedSize ?? 0} of ${stats?.rawSize ?? 0} · ${summary.comparables} used last scan` +
          (watch.maxRobustZ === null ? " · z-gate off" : ` · z ≤ ${watch.maxRobustZ}`),
      }),
    ]);
    if (summary.error) market.append(el("div", { class: "market-bad", text: `${summary.error}: ${run.message || ""}`.trim() }));
    box.append(market);
  }
}

function renderChecks() {
  const box = $("checks");
  box.replaceChildren();
  if (!checks) {
    box.append(el("p", { class: "hint", text: "Not run yet. This makes one real request per marketplace." }));
    return;
  }
  for (const result of checks) {
    const node = el("div", { class: "check" }, [
      el("div", { class: result.ok ? "check-ok" : "check-bad", text: `${result.ok ? "OK" : "FAILED"} · ${marketplaceLabel(result.marketplace)}` }),
      el("div", { class: "check-advice", text: result.detail || "" }),
    ]);
    if (result.advice) node.append(el("div", { class: "check-advice", text: result.advice }));
    box.append(node);
  }
  const tabs = state?.tabs || {};
  const open = Object.entries(tabs).filter(([, available]) => available);
  box.append(
    el("p", {
      class: "hint",
      text: open.length
        ? `open tabs the extension can borrow: ${open.map(([id]) => marketplaceLabel(id)).join(" · ")}`
        : "no marketplace tab is open right now: page-based sources will use the service worker, " +
          "and the ones set to 'reads your tab' need you to open the site first.",
    }),
  );
}

function renderLog() {
  const list = $("log");
  list.replaceChildren();
  for (const entry of state.log || []) {
    list.append(
      el("li", { class: `lvl-${entry.level}` }, [
        el("time", { text: relativeTime(entry.at) }),
        el("span", { text: `${entry.watch ? `${entry.watch}: ` : ""}${entry.message}` }),
      ]),
    );
  }
  if (!(state.log || []).length) list.append(el("li", { text: "nothing yet" }));
}

// --- opportunities ---------------------------------------------------------

function opportunityCard(item) {
  const node = $("opportunity-template").content.firstElementChild.cloneNode(true);
  const verdictChip = node.querySelector(".chip-verdict");
  verdictChip.textContent = verdictLabel(item.verdict);
  verdictChip.classList.add(
    item.verdict === "buy" ? "is-buy" : item.verdict === "watch" ? "is-watch" : item.verdict === "skip" ? "is-skip" : "is-unknown",
  );
  node.querySelector(".chip-category").textContent = item.category;
  node.querySelector(".chip-confidence").textContent = `${item.confidence} confidence`;
  node.querySelector(".opp-name").textContent = item.name;
  node.querySelector(".opp-headline").textContent = opportunityHeadline(item);

  // The reference is always stated, measured or not: "no resale price measured" is a
  // fact about the run, and leaving it out made the card look like the feature was
  // missing rather than like the sample was.
  const reference = resaleReference(item);
  const referenceBox = node.querySelector(".reference");
  referenceBox.classList.toggle("is-none", !reference.measured);
  node.querySelector(".reference-value").textContent = reference.value;
  node.querySelector(".reference-samples").textContent = reference.detail;

  node.querySelector(".opp-meta").textContent =
    `${scoreLine(item)} · buy side: ${marketplaceList(item.buyMarket || [])} · keyword "${item.keyword}"`;
  node.querySelector(".opp-confidence").textContent = confidenceLine(item);

  const reasons = node.querySelector(".opp-reasons");
  for (const reason of item.reasons || []) reasons.append(el("li", { text: reason }));

  // Both actions always lead somewhere. A measured URL is used when the run stored
  // one; otherwise the keyword becomes a search on that marketplace, which is what
  // the button promised to do in the first place.
  const buy = node.querySelector(".opp-buy");
  const buyHref = item.buyUrl || sourceSearchUrl((item.buyMarket || [])[0], item.keyword);
  if (buyHref) {
    buy.href = buyHref;
    buy.textContent = item.buyUrl ? "Open a buy listing" : "Search the buy side";
  } else {
    buy.hidden = true;
  }
  const resale = node.querySelector(".opp-resale");
  const resaleHref = item.resaleUrl || sourceSearchUrl(item.resaleSource, item.keyword) || sourceSearchUrl("ebay", item.keyword);
  if (resaleHref) {
    resale.href = resaleHref;
    resale.textContent = item.resaleUrl ? "Resale reference" : "Search the resale side";
  } else {
    resale.hidden = true;
  }
  node.querySelector(".opp-watch").addEventListener("click", () => trackAsWatch(item));
  return node;
}

function renderOpportunities() {
  const box = $("opportunities");
  if (!box) return;
  const all = state.opportunities || [];
  const rows = visibleOpportunities(all, {
    verdict: filters.verdict,
    category: filters.category,
    text: filters.opportunityText,
    sort: filters.opportunitySort,
    actionableOnly: filters.opportunityActionable === "1",
  });

  const last = lastRunLine(state.opportunityRuns);
  $("opportunity-last").textContent = opportunityScanning ? `${last} · analysis running...` : last;

  const notes = $("opportunity-notes");
  const lastErrors = state.opportunityRuns?.[0]?.errors || [];
  const needsAck = !state.settings?.acknowledgeAll;
  const needsKeys = !state.settings?.ebayClientId || !state.settings?.ebayClientSecret;
  const warnings = [];
  if (needsAck) {
    warnings.push(
      "Vinted, leboncoin and Back Market have no public search API, and this run reads them from your own browser session. " +
        "Tick \"I accept the terms\" in Settings to allow the buy side to be sampled.",
    );
  }
  if (needsKeys) {
    warnings.push(
      "No eBay keyset yet, so eBay cannot be used as a resale reference. Add your Client ID and Secret in Settings, " +
        "or set a manual resale price per product in the catalogue.",
    );
  }
  warnings.push(...lastErrors.slice(0, 4));
  notes.hidden = warnings.length === 0;
  notes.textContent = warnings.join("  ·  ");

  const category = $("filter-category");
  const known = opportunityCategories(all);
  const current = category.value;
  category.replaceChildren(el("option", { value: "", text: "all categories" }));
  for (const name of known) category.append(el("option", { value: name, text: name }));
  category.value = known.includes(current) ? current : "";

  box.replaceChildren();
  const empty = $("opportunities-empty");
  if (!rows.length) {
    empty.hidden = false;
    empty.textContent = all.length
      ? "Nothing matches these filters. Clear them, or look at \"every verdict\" - a run that found no margin still measured every product."
      : "Nothing measured yet. Press \"Run analysis\" to sample the catalogue on both sides of the market.";
    return;
  }
  empty.hidden = true;
  for (const item of rows) box.append(opportunityCard(item));
}

/** Turn a scored product into a normal watch on its buy side. */
async function trackAsWatch(item) {
  const marketplace = (item.buyMarket || ["vinted"])[0];
  const name = `${item.name} (opp)`;
  if ((state.watches || []).some((watch) => watch.name === name)) {
    toast(`"${name}" is already a watch`, "");
    return;
  }
  const watches = [
    ...(state.watches || []).map(watchToForm).map((form) => safeWatch(form)),
    {
      ...safeWatch(blankWatchForm(marketplace)),
      name,
      searchText: item.keyword,
      marketplace,
      plausibleMinPrice: Math.max(1, Math.round((item.buyPrice ?? 20) * 0.5)),
      plausibleMaxPrice: Math.ceil((item.resalePrice ?? 500) * 1.1),
      minDiscount: 0.25,
      exactPhrase: true,
    },
  ];
  await send({ type: "setWatches", watches });
  watchesDirty = false;
  await refresh();
  showPage("deals");
  toast(`added "${name}" as a watch - it will be scanned on the next pass`, "good");
}

/** A form that failed to validate must not take the whole save down with it. */
function safeWatch(form) {
  try {
    return formToWatch(form);
  } catch {
    return form;
  }
}

// --- catalogue -------------------------------------------------------------

const CATALOG_FIELDS = [
  "enabled",
  "name",
  "keyword",
  "plausibleMinPrice",
  "plausibleMaxPrice",
  "buyMarket",
  "resaleSource",
  "resaleSources",
  "manualResalePrice",
  "wikipedia",
];

// These two are lists in the model and a comma-separated line in the row.
const CATALOG_LIST_FIELDS = new Set(["buyMarket", "resaleSources"]);

function catalogListText(value) {
  if (Array.isArray(value)) return value.join(", ");
  return value === null || value === undefined ? "" : String(value);
}

function parseCatalogList(text) {
  return String(text || "")
    .split(/[,\n]/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function catalogRow(item) {
  const node = $("catalog-template").content.firstElementChild.cloneNode(true);
  for (const input of node.querySelectorAll("[data-field]")) {
    const value = item?.[input.dataset.field];
    if (input.type === "checkbox") input.checked = value !== false;
    else if (CATALOG_LIST_FIELDS.has(input.dataset.field)) input.value = catalogListText(value);
    else input.value = value === null || value === undefined ? "" : String(value);
    if (input.tagName === "SELECT" && input.value !== String(value)) input.value = "ebay";
  }
  node.querySelector(".remove").addEventListener("click", () => {
    node.remove();
    catalogDirty = true;
  });
  return node;
}

function readCatalog() {
  const items = [];
  for (const node of document.querySelectorAll("#catalog .catalog-row")) {
    const raw = {};
    for (const input of node.querySelectorAll("[data-field]")) {
      if (input.type === "checkbox") raw[input.dataset.field] = input.checked;
      else if (CATALOG_LIST_FIELDS.has(input.dataset.field)) raw[input.dataset.field] = parseCatalogList(input.value);
      else raw[input.dataset.field] = input.value;
    }
    items.push(raw); // the worker validates them; see core/catalog.js
  }
  return items;
}

function renderCatalog({ force = false } = {}) {
  const box = $("catalog");
  if (!box) return;
  const signature = signatureOf(state.catalog);
  if (!force && catalogDirty && signature === catalogSignature) return;
  box.replaceChildren();
  for (const item of state.catalog || []) box.append(catalogRow(item));
  catalogSignature = signature;
  catalogDirty = false;
}

async function saveCatalog() {
  const error = $("catalog-error");
  try {
    const saved = await send({ type: "setCatalog", catalog: readCatalog() });
    catalogDirty = false;
    error.hidden = true;
    error.textContent = "";
    toast(`saved ${saved?.catalog?.length ?? 0} catalogue product(s)`, "good");
    await refresh();
    renderCatalog({ force: true });
  } catch (err) {
    error.hidden = false;
    error.textContent = String(err.message || err).replace(/^Error: /, "");
  }
}

async function doOpportunityScan() {
  const button = $("scan-opportunities");
  button.disabled = true;
  const previous = (state.opportunities || []).filter((item) => item.verdict === "buy").length;
  try {
    const result = await send({ type: "scanOpportunities", reason: "dashboard" });
    await refresh();
    const now = (state.opportunities || []).filter((item) => item.verdict === "buy").length;
    const summary = result?.summary || {};
    toast(
      `opportunities: ${summary.products ?? 0} product(s) measured, ${now} worth buying (${now - previous >= 0 ? "+" : ""}${now - previous}), ` +
        `${summary.requests ?? 0} request(s)`,
      now ? "good" : "",
    );
  } catch (err) {
    toast(`opportunity analysis failed: ${err.message}`, "bad");
  } finally {
    button.disabled = false;
  }
}

// --- history ---------------------------------------------------------------

function renderHistory() {
  const body = $("history-body");
  if (!body) return;
  const rows = historyRows(state.history || [], {
    kind: filters.historyKind,
    watch: filters.historyWatch,
    text: filters.historyText,
    limit: 300,
  });

  const select = $("filter-history-watch");
  const current = select.value;
  select.replaceChildren(el("option", { value: "", text: "all" }));
  for (const watch of state.watches || []) select.append(el("option", { value: watch.name, text: watch.name }));
  select.value = (state.watches || []).some((w) => w.name === current) ? current : "";

  body.replaceChildren();
  const empty = $("history-empty");
  if (!rows.length) {
    empty.hidden = false;
    empty.textContent = state.history?.length
      ? "Nothing matches these filters."
      : "No history yet: it fills up as scans run.";
  } else {
    empty.hidden = true;
  }

  for (const row of rows) {
    const node = $("history-template").content.firstElementChild.cloneNode(true);
    node.classList.toggle("is-error", Boolean(row.error));
    node.querySelector(".h-when").textContent = historyWhen(row);
    node.querySelector(".h-kind").textContent = row.kind === "opportunities" ? "opportunities" : marketplaceLabel(row.marketplace || "watch");
    node.querySelector(".h-watch").textContent = row.watch || "—";
    node.querySelector(".h-summary").textContent = historySummary(row);
    node.querySelector(".h-error").textContent = row.error ? `${row.error}${row.message ? `: ${row.message}` : ""}` : "";
    body.append(node);
  }

  const spark = $("sparklines");
  spark.replaceChildren();
  let drawn = 0;
  for (const watch of state.watches || []) {
    const series = priceSeries(state.history || [], watch.name);
    const box = el("div", { class: "spark" }, [
      el("div", { class: "spark-name", text: watch.name }),
      el("div", {
        class: "spark-line",
        text: series.length
          ? `${series.length} scan(s) · latest ${money(series[series.length - 1].marketPrice, series[series.length - 1].currency || "EUR")}`
          : "not enough scans yet",
      }),
    ]);
    const path = sparklinePath(series, { width: 220, height: 44 });
    if (path) {
      drawn += 1;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 220 44");
      svg.setAttribute("preserveAspectRatio", "none");
      const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
      line.setAttribute("d", path);
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", "#2ea043");
      line.setAttribute("stroke-width", "2");
      svg.append(line);
      box.append(svg);
    }
    spark.append(box);
  }
  if (!drawn) spark.append(el("p", { class: "hint", text: "Two scans of the same watch are needed before a line means anything." }));
}

// --- settings --------------------------------------------------------------

const SETTINGS_GROUPS = [
  {
    legend: "Scanning",
    fields: [
      { key: "intervalMinutes", label: "scan interval (minutes)", type: "number" },
      { key: "perPage", label: "listings per request", type: "number" },
      { key: "notifications", label: "desktop notifications", type: "checkbox" },
      {
        key: "leboncoinTransport",
        label: "leboncoin transport",
        type: "select",
        options: ["auto", "tab", "api", "page"],
        note: "auto uses your open leboncoin tab when there is one, then the api, then the page",
      },
      {
        key: "acknowledgeAll",
        label: "I accept the terms for Vinted / leboncoin / Back Market (personal, low-volume use)",
        type: "checkbox",
      },
    ],
  },
  {
    legend: "Opportunities",
    fields: [
      { key: "opportunityIntervalMinutes", label: "opportunity run interval (minutes)", type: "number" },
      { key: "opportunityPerPage", label: "listings per marketplace sample", type: "number" },
      { key: "opportunityMaxProducts", label: "products per run", type: "number" },
      { key: "opportunityMinMargin", label: "minimum net margin (%)", type: "percent" },
      { key: "opportunityMinConfidence", label: "minimum confidence", type: "select", options: ["low", "medium", "high"] },
      { key: "trendWikipedia", label: "public interest (Wikimedia pageviews)", type: "checkbox", path: ["trendSources", "wikipedia"] },
      { key: "trendGdelt", label: "news attention (GDELT)", type: "checkbox", path: ["trendSources", "gdelt"] },
      { key: "socialKeywords", label: "your own hot keywords (comma or newline separated)", type: "list" },
    ],
  },
  {
    legend: "Resale references",
    fields: [
      { key: "ebayClientId", label: "eBay Client ID", type: "text" },
      { key: "ebayClientSecret", label: "eBay Client Secret", type: "password" },
      { key: "ebayMarketplaceId", label: "eBay marketplace id", type: "text", note: "EBAY_FR, EBAY_DE, EBAY_GB..." },
      { key: "backmarketDomain", label: "Back Market domain", type: "text", note: "www.backmarket.fr, www.backmarket.com" },
    ],
  },
  {
    legend: "Data providers (optional, bring your own key)",
    fields: [
      { key: "googleShoppingResale", label: "use Google Shopping as an extra resale reference (SerpApi, one search per product)", type: "checkbox" },
      { key: "trendGoogle", label: "use Google Trends for the demand signal (SerpApi)", type: "checkbox", path: ["trendSources", "googleTrends"] },
      { key: "useApifyFallback", label: "fall back to an Apify actor when a marketplace has no open tab and no search URL", type: "checkbox" },
      { key: "apifyToken", label: "Apify API token", type: "password" },
      { key: "serpApiKey", label: "SerpApi key", type: "password" },
      { key: "brightDataToken", label: "Bright Data API token", type: "password" },
      { key: "brightDataZone", label: "Bright Data unlocker zone", type: "text" },
      { key: "keepaKey", label: "Keepa API key", type: "password" },
    ],
  },
];

const getPath = (object, path) => path.reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), object);

function settingsField(spec) {
  const path = spec.path || [spec.key];
  const value = getPath(state.settings || {}, path);
  if (spec.type === "checkbox") {
    const input = el("input", { type: "checkbox" });
    input.checked = Boolean(value);
    input.dataset.key = spec.key;
    input.dataset.path = path.join(".");
    return el("label", { class: "check" }, [input, el("span", { text: spec.label })]);
  }
  let input;
  if (spec.type === "select") {
    input = el("select", {});
    for (const option of spec.options) input.append(el("option", { value: option, text: option, ...(option === value ? { selected: "selected" } : {}) }));
  } else if (spec.type === "list") {
    input = el("textarea", {});
    input.value = (value || []).join(", ");
  } else {
    input = el("input", { type: spec.type === "number" ? "number" : spec.type === "password" ? "password" : "text" });
    input.value = spec.type === "percent" ? String(Math.round((Number(value) || 0) * 100)) : value ?? "";
  }
  input.dataset.key = spec.key;
  input.dataset.path = path.join(".");
  const children = [el("span", { text: spec.label }), input];
  if (spec.note) children.push(el("span", { class: "note", text: spec.note }));
  return el("label", {}, children);
}

function renderSettings() {
  const box = $("settings-form");
  if (!box) return;
  const focusKey = document.activeElement?.dataset?.key || null;
  box.replaceChildren();
  for (const group of SETTINGS_GROUPS) {
    const fieldset = el("fieldset", {}, [el("legend", { text: group.legend })]);
    for (const spec of group.fields) fieldset.append(settingsField(spec));
    box.append(fieldset);
  }
  if (focusKey) {
    const target = [...box.querySelectorAll("[data-key]")].find((node) => node.dataset.key === focusKey);
    target?.focus();
  }
}

function readSettings() {
  const patch = {};
  for (const node of document.querySelectorAll("#settings-form [data-key]")) {
    const path = node.dataset.path.split(".");
    const spec = SETTINGS_GROUPS.flatMap((group) => group.fields).find((field) => field.key === node.dataset.key);
    let value = node.type === "checkbox" ? node.checked : node.value;
    if (spec?.type === "number") value = Number(value);
    if (spec?.type === "percent") value = Number(String(value).replace("%", "").replace(",", ".")) / 100;
    if (spec?.type === "list") {
      value = String(value)
        .split(/[,\n]/)
        .map((part) => part.trim())
        .filter(Boolean);
    }
    if (path.length === 2) {
      patch[path[0]] = { ...(patch[path[0]] || state.settings?.[path[0]] || {}), [path[1]]: value };
    } else {
      patch[path[0]] = value;
    }
  }
  return patch;
}

async function saveSettings() {
  const error = $("settings-error");
  try {
    await send({ type: "setSettings", settings: readSettings() });
    error.hidden = true;
    await refresh();
    toast("settings saved", "good");
  } catch (err) {
    error.hidden = false;
    error.textContent = String(err.message || err).replace(/^Error: /, "");
  }
}

// --- sources ----------------------------------------------------------------

/**
 * One row per marketplace, straight from the worker's registry dump. The dashboard
 * never hard-codes this list, so a source cannot exist in the engine and be missing
 * from the page (or the other way round).
 */
function sourceRow(source) {
  const node = $("source-template").content.firstElementChild.cloneNode(true);
  node.classList.toggle("is-off", !source.enabled);
  node.dataset.source = source.id;

  const fields = {};
  for (const input of node.querySelectorAll("[data-field]")) fields[input.dataset.field] = input;

  fields.enabled.checked = Boolean(source.enabled);
  fields.acknowledgeTerms.checked = Boolean(source.settings?.acknowledgeTerms);
  fields.urlTemplate.value = source.settings?.urlTemplate || "";
  fields.actor.value = source.settings?.actor || "";
  const mode = source.settings?.mode || "auto";
  fields.mode.value = ["auto", "search-url", "open-tab"].includes(mode) ? mode : "auto";

  node.querySelector(".source-label").textContent = source.label;
  node.querySelector(".chip-kind").textContent = source.kind;
  node.querySelector(".chip-access").textContent = source.access === "official-api" ? "documented API" : "page";
  node.querySelector(".chip-mode").textContent = source.mode === "open-tab" ? "reads your tab" : source.mode;
  const status = node.querySelector(".source-status");
  status.textContent = source.enabled ? source.status : "switched off";
  status.classList.add(
    source.enabled ? (/ready/.test(source.status) ? "is-ok" : /credential|tab/.test(source.status) ? "is-warn" : "is-muted") : "is-muted",
  );
  node.querySelector(".source-detail").textContent = source.detail;

  const open = node.querySelector(".source-open");
  const hint = (source.searchHint || "").replace("{query}", "iphone%2013");
  if (hint) open.href = hint;
  else open.hidden = true;

  const terms = node.querySelector(".check-terms");
  if (source.terms === "documented") terms.hidden = true;
  node.querySelector(".source-note").textContent = source.note;
  node.querySelector(".source-terms").textContent = source.termsNote;
  const advice = node.querySelector(".source-advice");
  advice.textContent = source.advice;
  advice.hidden = !source.advice;

  for (const field of ["enabled", "mode", "urlTemplate", "actor", "acknowledgeTerms"]) {
    fields[field].addEventListener("change", async () => {
      const patch =
        field === "enabled" || field === "acknowledgeTerms"
          ? { [field]: fields[field].checked }
          : { [field]: fields[field].value };
      sourcesDirty = false;
      try {
        await send({ type: "setSource", marketplace: source.id, patch });
        await refresh();
        toast(`${source.label}: saved`, "good");
      } catch (err) {
        toast(`could not save ${source.label}: ${err.message}`, "bad");
      }
    });
  }

  node.querySelector(".source-test").addEventListener("click", async (event) => {
    const output = node.querySelector(".source-check");
    const button = event.currentTarget;
    button.disabled = true;
    output.textContent = "asking...";
    try {
      const result = await send({ type: "selfCheck", marketplace: source.id });
      const first = result?.results?.[0];
      output.textContent = first ? `${first.ok ? "OK" : "FAILED"} · ${first.detail}` : "no answer";
      output.className = `source-check ${first?.ok ? "is-ok" : "is-bad"}`;
      if (first && !first.ok) toast(`${source.label}: ${first.detail}`, "bad");
    } catch (err) {
      output.textContent = String(err.message || err);
      output.className = "source-check is-bad";
    } finally {
      button.disabled = false;
    }
  });
  return node;
}

function renderSources({ force = false } = {}) {
  const box = $("sources-list");
  if (!box) return;
  const sources = state.sources || [];
  const signature = signatureOf(sources.map((source) => ({ ...source, settings: source.settings || {} })));
  if (!force && sourcesDirty && signature === sourcesSignature) return;
  box.replaceChildren();
  if (!sources.length) {
    box.append(el("p", { class: "hint", text: "The worker did not report any sources." }));
    return;
  }
  for (const source of sources) box.append(sourceRow(source));
  const tabOpen = Object.values(state.tabs || {}).filter(Boolean).length;
  $("sources-hint").textContent =
    `${sources.length} source(s) known, ${sources.filter((source) => source.enabled).length} switched on` +
    ` · ${tabOpen} borrowable marketplace tab(s) open` +
    ` · ${sources.filter((source) => source.credentialReady === false).length} waiting for a key`;
  sourcesSignature = signature;
  sourcesDirty = false;
}

function renderProviders() {
  const box = $("providers-list");
  if (!box) return;
  box.replaceChildren();
  for (const provider of state.providers || []) {
    const node = $("provider-template").content.firstElementChild.cloneNode(true);
    node.querySelector(".provider-label").textContent = provider.label;
    const status = node.querySelector(".provider-status");
    status.textContent = provider.configured ? "key saved" : "needs a key";
    status.classList.add(provider.configured ? "is-ok" : "is-warn");
    node.querySelector(".provider-what").textContent = provider.what;
    node.querySelector(".provider-legal").textContent = provider.legal;
    node.querySelector(".provider-meta").textContent =
      `covers: ${provider.covers.join(", ")} · free tier: ${provider.freeTier} · keys: ` +
      provider.keys.map((entry) => entry.key).join(", ");
    for (const [selector, url] of [
      [".provider-docs", provider.docsUrl],
      [".provider-signup", provider.signupUrl],
    ]) {
      const link = node.querySelector(selector);
      if (url) link.href = url;
      else link.hidden = true;
    }
    box.append(node);
  }
}

// --- API keys: how to actually wire one up --------------------------------

/**
 * The instructions a key page is useless without.
 *
 * The explanations of *what* each provider does live in core/providers.js (the
 * registry, so they cannot drift from the code that calls them). What the registry
 * cannot know is the click-path in each vendor's dashboard and which switch in this
 * extension spends the key - so that part is here, and every step is plain text with
 * `code` tokens for values the user has to type.
 */
const PROVIDER_SETUP = {
  apify: {
    steps: [
      ["Create an account in the Apify Console - the free plan includes a monthly usage credit."],
      ["In the console, open Settings → API & Integrations and copy the personal API token. It starts with ", { code: "apify_api_" }, "."],
      ["Paste it into Settings under ", { bold: "Apify API token" }, ", then press " , { bold: "Save settings" }, "."],
      [
        "In Settings, also tick ",
        { bold: "fall back to an Apify actor when a marketplace has no open tab and no search URL" },
        " - without that switch the token is never spent.",
      ],
      [
        "Open Marketplaces, find the site you want (Vinted, leboncoin, Easy Cash, momox...), and paste the actor id from the Apify store into that row's ",
        { code: "Apify actor" },
        " box, for example ",
        { code: "user~actor-name" },
        ".",
      ],
      ["Tick that row's terms box and press Test this source. Using an actor is not permission from the marketplace, so prefer actors you have a licence for."],
    ],
  },
  serpapi: {
    steps: [
      ["Create an account at serpapi.com: 250 searches a month are free, paid plans after that."],
      ["Copy the API key from your SerpApi dashboard."],
      ["Paste it into Settings under ", { bold: "SerpApi key" }, ", then press ", { bold: "Save settings" }, "."],
      [
        "The key alone changes nothing: now tick ",
        { bold: "use Google Shopping as an extra resale reference" },
        " and/or ",
        { bold: "use Google Trends for the demand signal" },
        ". Each one spends a search per product, which is why both start off.",
      ],
    ],
  },
  brightdata: {
    steps: [
      ["Create an account at Bright Data."],
      ["Copy your API token from the dashboard."],
      ["Create a Web Unlocker zone and note its name - the zone is what actually fetches a page."],
      [
        "Paste the token into ",
        { bold: "Bright Data API token" },
        " and the zone name into ",
        { bold: "Bright Data unlocker zone" },
        ", then Save settings. Both are needed: with only the token, requests fail with no zone configured.",
      ],
      ["On Marketplaces, leave that site's 'how to reach it' on auto (recommended). The unlocker is tried when your own network is refused."],
    ],
  },
  keepa: {
    steps: [
      ["Create a Keepa account, then subscribe to the API - it bills in token buckets, with a small free allowance for testing."],
      ["Copy the API key from the Keepa API page."],
      ["Paste it into Settings under ", { bold: "Keepa API key" }, ", then press ", { bold: "Save settings" }, "."],
      ["Keepa covers Amazon marketplaces only: it is a price-history reference, not somewhere to buy. No key, no data."],
    ],
  },
};

const LAST_STEP = [
  "Prove it works: press ",
  { bold: "Test every enabled source" },
  " on the Marketplaces page. Each source reports what actually happened, in its own words.",
];

/**
 * Which setting each key of a credential belongs in, and what is still missing.
 *
 * The keys come from the registry when it describes them; when it only lists what is
 * missing (a keyset the user has not filled in), the same rows are derived from the
 * Settings form - so the card always names the exact field to paste into, which is
 * the whole point of the page.
 */
function credentialRows({ keys = [], missing = [] } = {}) {
  const list = el("ul", { class: "setup-keys" });
  const described = keys.length ? keys.map((entry) => ({ key: entry.key, note: entry.note })) : missing.map((key) => ({ key, note: "" }));
  for (const entry of described) {
    list.append(
      el("li", {}, [
        el("code", { text: entry.key }),
        document.createTextNode(` → Settings → "${settingsFieldLabel(entry.key)}"${entry.note ? ` (${entry.note})` : ""}`),
      ]),
    );
  }
  if (missing.length) list.append(el("li", { text: `missing right now: ${missing.join(", ")}` }));
  return list;
}

/** The Settings label for a settings key, so a step can name the exact field. */
function settingsFieldLabel(key) {
  for (const group of SETTINGS_GROUPS) {
    const spec = group.fields.find((field) => field.key === key);
    if (spec) return spec.label;
  }
  return key;
}

/** A step is a list of strings and tokens, rendered without touching innerHTML. */
function stepParts(step) {
  return step.map((part) => {
    if (typeof part === "string") return document.createTextNode(part);
    if (part.code) return el("code", { text: part.code });
    if (part.bold) return el("strong", { text: part.bold });
    return document.createTextNode(String(part));
  });
}

function setupSteps(steps) {
  const list = el("ol", { class: "setup-steps" });
  for (const step of [...steps, LAST_STEP]) list.append(el("li", {}, stepParts(step)));
  return list;
}

/**
 * The API-keys page: one card per provider, built from the live registry so a
 * provider added to core/providers.js appears here (with its real key names and
 * real docs link) instead of only existing in the code.
 */
function renderApiSetup() {
  const box = $("api-setup");
  if (!box) return;
  box.replaceChildren();

  // eBay first: it is the only key the extension actively expects, because it is a
  // documented API and the preferred resale reference.
  const ebay = (state.sources || []).find((source) => source.id === "ebay");
  if (ebay?.credentials) {
    const card = $("setup-template").content.firstElementChild.cloneNode(true);
    card.classList.toggle("is-ready", ebay.credentialReady !== false);
    card.querySelector(".setup-label").textContent = ebay.credentials.label || "eBay developer keyset";
    const status = card.querySelector(".setup-status");
    status.textContent = ebay.credentialReady === false ? "needs a key" : "key saved";
    status.classList.add(ebay.credentialReady === false ? "is-warn" : "is-ok");
    card.querySelector(".setup-lead").textContent =
      "The terms-compliant path, and the resale reference that decides most verdicts. " +
      "A free developer account is enough: no seller account, no listing fees, no approval to read public listings.";
    card.querySelector(".setup-steps").replaceWith(
      setupSteps([
        ["Sign in to the eBay developer programme with any eBay account (the free membership is enough)."],
        ["Create an application in the developer portal: that produces a keyset with an App ID and a Cert ID."],
        [
          "Paste the App ID into Settings under ",
          { bold: "eBay Client ID" },
          " and the Cert ID into ",
          { bold: "eBay Client Secret" },
          ", then press Save settings.",
        ],
        [
          "Set the marketplace to match your country with ",
          { code: "EBAY_FR" },
          ", ",
          { code: "EBAY_DE" },
          ", ",
          { code: "EBAY_GB" },
          "... (the default is ",
          { code: "EBAY_FR" },
          "), then Save settings.",
        ],
        ["Tick 'terms acknowledged' where asked. Keys are stored locally and sent only to eBay."],
      ]),
    );
    card.querySelector(".setup-keys").replaceWith(credentialRows(ebay.credentials));
    const docs = card.querySelector(".provider-docs");
    if (ebay.credentials.docsUrl) docs.href = ebay.credentials.docsUrl;
    else docs.hidden = true;
    card.querySelector(".provider-signup").href = ebay.credentials.docsUrl || "https://developer.ebay.com/";
    card.querySelector(".provider-signup").textContent = "Open the developer portal";
    card.querySelector(".setup-settings").addEventListener("click", () => showPage("settings"));
    card.querySelector(".setup-legal").textContent =
      "This is a personal keyset, not a partnership: eBay intends production use beyond development for approved " +
      "partners. It returns asking prices - sold-price history (Marketplace Insights) is invite-only and is not used here.";
    box.append(card);
  }

  for (const provider of state.providers || []) {
    const spec = PROVIDER_SETUP[provider.id];
    const card = $("setup-template").content.firstElementChild.cloneNode(true);
    card.classList.toggle("is-ready", Boolean(provider.configured));
    card.querySelector(".setup-label").textContent = provider.label;
    const status = card.querySelector(".setup-status");
    status.textContent = provider.configured ? "key saved" : "optional — no key yet";
    status.classList.add(provider.configured ? "is-ok" : "is-warn");
    card.querySelector(".setup-lead").textContent = `${provider.what} Free tier: ${provider.freeTier}. Covers: ${provider.covers.join(", ")}.`;
    card.querySelector(".setup-steps").replaceWith(setupSteps(spec?.steps || []));
    card.querySelector(".setup-keys").replaceWith(credentialRows({ keys: provider.keys }));
    for (const [selector, url] of [
      [".provider-signup", provider.signupUrl],
      [".provider-docs", provider.docsUrl],
    ]) {
      const link = card.querySelector(selector);
      if (url) link.href = url;
      else link.hidden = true;
    }
    card.querySelector(".setup-settings").addEventListener("click", () => showPage("settings"));
    card.querySelector(".setup-legal").textContent = `${provider.legal} The key is stored in this browser profile and is sent only to ${provider.label}.`;
    box.append(card);
  }

  if (!box.children.length) box.append(el("p", { class: "hint", text: "The worker did not report any providers." }));
}

// --- price check -----------------------------------------------------------

function renderPriceMarkets() {
  const select = $("price-market");
  if (!select) return;
  const current = select.value;
  const sources = (state.sources || []).filter((source) => source.enabled);
  select.replaceChildren();
  for (const source of sources) {
    const suffix = source.credentialReady === false ? " (needs a key)" : source.mode === "open-tab" ? " (reads your tab)" : "";
    select.append(el("option", { value: source.id, text: `${source.label}${suffix}` }));
  }
  const preferred = ["vinted", "leboncoin", "ebay", "backmarket"];
  select.value = sources.some((source) => source.id === current)
    ? current
    : preferred.find((id) => sources.some((source) => source.id === id)) || sources[0]?.id || "";
}

async function doPriceCheck() {
  const button = $("price-run");
  const error = $("price-error");
  const keyword = $("price-keyword").value.trim();
  error.hidden = true;
  error.textContent = "";
  if (!keyword) {
    error.hidden = false;
    error.textContent = "Type what you want priced - a model name works better than a category.";
    return;
  }
  button.disabled = true;
  button.textContent = "asking...";
  try {
    const result = await send({
      type: "priceCheck",
      marketplace: $("price-market").value,
      keyword,
      minPrice: $("price-min").value,
      maxPrice: $("price-max").value,
    });
    renderPriceResult(result);
  } catch (err) {
    $("price-result").hidden = true;
    error.hidden = false;
    error.textContent = String(err.message || err).replace(/^Error: /, "");
  } finally {
    button.disabled = false;
    button.textContent = "Get the median";
  }
}

function renderPriceResult(result) {
  const box = $("price-result");
  if (!box) return;
  box.hidden = false;
  box.replaceChildren();
  if (!result?.ok) {
    box.append(el("h2", { text: "No median this time" }));
    box.append(el("p", { class: "hint", text: result?.detail || "the check did not answer" }));
    if (result?.advice) box.append(el("p", { class: "hint", text: result.advice }));
    return;
  }
  const stats = result.stats;
  box.append(el("h2", { text: `Median price · ${result.label} · "${result.keyword}"` }));
  box.append(
    el("p", {
      class: "hint",
      text:
        `${result.checked} listing(s) with a readable price in ${result.durationMs} ms` +
        (result.via ? ` · via ${result.via}` : "") +
        (result.totalEntries ? ` · about ${result.totalEntries} listings match on the site` : ""),
    }),
  );
  const stat = (label, value, primary = false) =>
    el("div", { class: "stat" }, [
      el("div", { class: `stat-value${primary ? " is-primary" : ""}`, text: value }),
      el("div", { class: "stat-label", text: label }),
    ]);
  box.append(
    el("div", { class: "price-numbers" }, [
      stat("median asking price", money(stats.median, result.currency), true),
      stat("middle half of the market", `${money(stats.q1, result.currency)} - ${money(stats.q3, result.currency)}`),
      stat("spread (MAD)", money(stats.mad, result.currency)),
      stat("listings kept", `${stats.usedSize} of ${stats.sampleSize}`),
    ]),
  );
  if (stats.sampleSize < 8) {
    box.append(
      el("p", {
        class: "hint",
        text: `Only ${stats.sampleSize} usable listing(s): read this as an anecdote, not a market. Widen the price band or use a plainer keyword.`,
      }),
    );
  }
  if ((result.cheapest || []).length) {
    box.append(el("h2", { text: "Cheapest listings seen" }));
    const list = el("ul", { class: "price-list" });
    for (const listing of result.cheapest) {
      list.append(
        el("li", {}, [
          el("span", { class: "p", text: money(listing.price, listing.currency || result.currency) }),
          el("a", {
            class: "t",
            href: listing.url,
            target: "_blank",
            rel: "noreferrer noopener",
            text: listing.title || "(untitled)",
          }),
        ]),
      );
    }
    box.append(list);
  }
}

// --- actions ---------------------------------------------------------------

async function doScan() {
  scanning = true;
  renderStatus();
  $("scan").disabled = true;
  const before = countByStatus(state?.alerts || []).new;
  let message = "";
  let kind = "";
  let warning = null;
  try {
    const result = await send({ type: "scan", force: true, reason: "dashboard" });
    await refresh();
    const found = countByStatus(state.alerts || []).new - before;
    message =
      found > 0
        ? `scan done: ${found} new deal(s) under the market price`
        : `scan done: ${result?.summary?.comparables ?? 0} comparable listing(s) checked, nothing below your threshold`;
    kind = found > 0 ? "good" : "";
  } catch (err) {
    message = `scan failed: ${err.message}`;
    kind = "bad";
  } finally {
    scanning = false;
    $("scan").disabled = false;
    warning = renderStatus();
  }
  // A blocked marketplace is more important than the scan summary, so only report
  // the scan when nothing is wrong - or when the scan itself was what failed.
  if (!warning || kind === "bad") toast(message, kind);
}

async function doSelfCheck() {
  $("self-check").disabled = true;
  try {
    const result = await send({ type: "selfCheck" });
    checks = result.results;
    renderChecks();
  } finally {
    $("self-check").disabled = false;
  }
}

async function doSourceCheckAll() {
  const button = $("check-all-sources");
  button.disabled = true;
  const previous = checks;
  try {
    const result = await send({ type: "selfCheck" });
    // Merge: the per-source "Test" buttons keep their individual answers.
    const byId = new Map((previous || []).map((entry) => [entry.marketplace, entry]));
    for (const entry of result?.results || []) byId.set(entry.marketplace, entry);
    checks = [...byId.values()];
    renderChecks();
    for (const entry of result?.results || []) {
      const node = document.querySelector(`.source-row[data-source="${entry.marketplace}"] .source-check`);
      if (!node) continue;
      node.textContent = `${entry.ok ? "OK" : "FAILED"} · ${entry.detail}`;
      node.className = `source-check ${entry.ok ? "is-ok" : "is-bad"}`;
    }
    const ok = (result?.results || []).filter((entry) => entry.ok).length;
    toast(`source check: ${ok} of ${(result?.results || []).length} answered`, ok ? "good" : "bad");
  } catch (err) {
    toast(`source check failed: ${err.message}`, "bad");
  } finally {
    button.disabled = false;
  }
}

function wire() {
  restoreFilters();
  showPage("deals");

  $("scan").addEventListener("click", doScan);
  $("self-check").addEventListener("click", doSelfCheck);
  $("test-notify").addEventListener("click", async () => {
    await send({ type: "notifyTest" });
    toast("sent a test notification - if nothing pops up, check your OS notification settings", "good");
  });
  $("add-watch").addEventListener("click", () => {
    const node = watchEditor({ ...blankWatchForm("vinted"), name: "new watch" }, 0);
    node.open = true;
    $("watches").append(node);
    watchesDirty = true;
  });
  $("save-watches").addEventListener("click", saveWatches);
  $("demo-watch").addEventListener("click", async () => {
    await send({ type: "addDemoWatch" });
    watchesDirty = false;
    await refresh();
    toast("added the offline demo watch: it pretends to be a marketplace, so nothing leaves your browser", "good");
  });
  $("clear-deals").addEventListener("click", () => clearDeals(false));
  $("clear-keep-starred").addEventListener("click", () => clearDeals(true));

  $("scan-opportunities").addEventListener("click", doOpportunityScan);
  // "How this is measured" opens the explanation and puts the caret on its summary,
  // which also brings it into view in a real browser. It used to flip the `hidden`
  // attribute on a `<section>` whose class set no display rule, so it appeared to do
  // nothing at all.
  $("opportunities-help").addEventListener("click", () => {
    const panel = $("opportunity-explanation");
    if (!panel) return;
    panel.open = true;
    panel.querySelector("summary")?.focus();
  });
  $("price-run").addEventListener("click", doPriceCheck);
  $("go-to-keys").addEventListener("click", () => showPage("providers"));
  $("go-to-settings-2").addEventListener("click", () => showPage("settings"));
  $("add-catalog").addEventListener("click", () => {
    const node = catalogRow({ enabled: true, resaleSource: "ebay", plausibleMinPrice: 20, plausibleMaxPrice: 500 });
    $("catalog").append(node);
    catalogDirty = true;
  });
  $("go-to-settings").addEventListener("click", () => showPage("settings"));
  $("check-all-sources").addEventListener("click", doSourceCheckAll);
  $("save-catalog").addEventListener("click", saveCatalog);
  $("save-settings").addEventListener("click", saveSettings);

  for (const tab of document.querySelectorAll(".pagenav-tab")) {
    tab.addEventListener("click", () => showPage(tab.dataset.page));
  }

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      if (tab.dataset.favourites) filters.favourite = true;
      else {
        filters.favourite = false;
        filters.status = tab.dataset.status;
      }
      paintTabs();
      persistFilters();
      renderDeals();
    });
  }

  for (const [id, key] of [
    ["filter-watch", "watch"],
    ["filter-marketplace", "marketplace"],
    ["filter-sort", "sort"],
    ["filter-discount", "minDiscount"],
    ["filter-text", "text"],
    ["filter-verdict", "verdict"],
    ["filter-category", "category"],
    ["filter-opportunity-sort", "opportunitySort"],
    ["filter-opportunity-text", "opportunityText"],
    ["filter-opportunity-actionable", "opportunityActionable"],
    ["filter-history-kind", "historyKind"],
    ["filter-history-watch", "historyWatch"],
    ["filter-history-text", "historyText"],
  ]) {
    const node = $(id);
    node.addEventListener("input", () => {
      filters[key] = node.value;
      persistFilters();
      renderDeals();
      renderOpportunities();
      renderHistory();
    });
  }

  // Anything typed into an editor marks it dirty: the periodic refresh must not
  // rebuild it, or the edit is silently thrown away.
  for (const container of ["watches", "catalog", "sources-list"]) {
    $(container).addEventListener("input", () => {
      if (container === "watches") watchesDirty = true;
      else if (container === "catalog") catalogDirty = true;
      else sourcesDirty = true;
    });
    $(container).addEventListener("change", () => {
      if (container === "watches") watchesDirty = true;
      else if (container === "catalog") catalogDirty = true;
      else sourcesDirty = true;
    });
  }

  // A live dashboard: bounce off the worker every few seconds, but only while the
  // tab is visible, and never while a manual scan is running.
  setInterval(() => {
    if (!document.hidden && !scanning) refresh().catch(() => {});
  }, 5000);
}

async function clearDeals(keepFavourites) {
  const shown = visibleDeals(state?.alerts || [], activeFilters());
  const cleared = await send({ type: "clearAlerts", keepFavourites });
  await refresh();
  toast(
    `removed ${cleared.removed} stored deal(s) (${shown.length} were on screen) · the badge is clear` +
      (keepFavourites ? " · starred deals kept" : ""),
  );
}

async function boot() {
  wire();
  await refresh(); // the service worker seeds the offline demo watch on install
  doSelfCheck().catch(() => {});
}

boot();
