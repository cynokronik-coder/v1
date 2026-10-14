/**
 * The dashboard.
 *
 * Everything that can be wrong quietly (filtering, formatting, form -> watch) lives
 * in src/ui/*.js and is tested in node; this file is only the DOM wiring and the
 * messages it sends to the service worker.
 */

import {
  countByStatus,
  dealHeadline,
  marketplaceLabel,
  money,
  percent,
  relativeTime,
  untilTime,
  visibleDeals,
  watchSummary,
} from "./ui/format.js";
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
const filters = { status: "new", watch: "", marketplace: "", text: "", minDiscount: "", sort: "newest" };

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
  $("filter-watch").value = filters.watch;
  $("filter-marketplace").value = filters.marketplace;
  $("filter-sort").value = filters.sort;
  $("filter-discount").value = filters.minDiscount;
  $("filter-text").value = filters.text;
  for (const tab of document.querySelectorAll(".tab")) tab.classList.toggle("is-active", tab.dataset.status === filters.status);
}

function toast(message, kind = "") {
  const banner = $("banner");
  banner.textContent = message;
  banner.className = `banner ${kind}`;
  banner.hidden = !message;
}

async function refresh() {
  try {
    state = await send({ type: "getState" });
    scanning = Boolean(state.scanning);
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
}

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
        "Open that marketplace in a normal tab so the browser has a real session, then scan again.",
      "bad",
    );
    return "blocked";
  }
  toast("");
  return null;
}

function renderDeals() {
  const container = $("deals");
  const deals = visibleDeals(state.alerts || [], activeFilters());
  container.replaceChildren();
  const empty = $("deals-empty");

  if (!deals.length) {
    empty.hidden = false;
    empty.textContent = state.watches.length
      ? "Nothing here yet. Deals appear when a scan finds a listing well below the market price."
      : "No watches yet - add one on the right, or try the offline demo to see how it looks.";
    return;
  }
  empty.hidden = true;

  const template = $("deal-template");
  for (const deal of deals) {
    const node = template.content.firstElementChild.cloneNode(true);
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
    node.querySelector(".title").textContent = deal.title || "(untitled)";
    node.querySelector(".headline").textContent = dealHeadline(deal);

    const detail = [deal.brand, deal.size, deal.condition].filter(Boolean).join(" · ");
    node.querySelector(".detail").textContent = detail || "no brand/condition stated";
    node.querySelector(".reasons").textContent = (deal.reasons || []).join(", ");

    const open = node.querySelector("a.open");
    open.href = deal.url;
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
    container.append(node);
  }
}

async function setStatus(key, status) {
  await send({ type: "setDealStatus", key, status });
  await refresh();
}

function renderWatches() {
  const box = $("watches");
  const hint = $("watches-hint");
  box.replaceChildren();
  if (!state.watches.length) {
    hint.textContent = "No watches. A watch is one product you want, on one marketplace.";
    return;
  }
  hint.textContent = `${state.watches.length} watch(es). Changes apply after "Save watches".`;
  state.watches.forEach((watch, index) => box.append(watchEditor(watch, index)));
}

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
    selectField("marketplace", "marketplace", form.marketplace, ["vinted", "leboncoin", "mock"]),
    el("div", { class: "full" }, [field("search text", "searchText", form.searchText)]),
    field("min discount %", "minDiscount", form.minDiscount),
    field("max robust z (off to ignore)", "maxRobustZ", form.maxRobustZ),
    field("min sample size", "minSampleSize", form.minSampleSize),
    field("must match (comma separated)", "mustMatch", form.mustMatch),
    field("must not match", "mustNotMatch", form.mustNotMatch),
    field("sizes", "sizes", form.sizes),
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
  details.append(el("button", { class: "btn remove", text: "Remove this watch", onclick: () => details.remove() }));
  return details;
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
    toast(`saved ${saved.watches.length} watch(es)`, "good");
    error.hidden = true;
    await refresh();
  } catch (err) {
    error.hidden = false;
    error.textContent = String(err.message || err).replace(/^Error: /, "");
    toast("");
  }
}

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

function wire() {
  restoreFilters();

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
  });
  $("save-watches").addEventListener("click", saveWatches);
  $("demo-watch").addEventListener("click", async () => {
    await send({ type: "addDemoWatch" });
    await refresh();
    toast("added the offline demo watch: it pretends to be a marketplace, so nothing leaves your browser", "good");
  });
  $("clear-deals").addEventListener("click", async () => {
    const shown = visibleDeals(state?.alerts || [], activeFilters());
    const cleared = await send({ type: "clearAlerts" });
    await refresh();
    toast(`removed ${cleared.removed} stored deal(s) (${shown.length} were on screen) · the badge is clear`);
  });

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      filters.status = tab.dataset.status;
      for (const other of document.querySelectorAll(".tab")) other.classList.toggle("is-active", other === tab);
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
  ]) {
    const node = $(id);
    node.addEventListener("input", () => {
      filters[key] = node.value;
      persistFilters();
      renderDeals();
    });
  }

  // A live dashboard: bounce off the worker every few seconds, but only while the
  // tab is visible, and never while a manual scan is running.
  setInterval(() => {
    if (!document.hidden && !scanning) refresh().catch(() => {});
  }, 5000);
}

async function boot() {
  wire();
  await refresh(); // the service worker seeds the offline demo watch on install
  doSelfCheck().catch(() => {});
}

boot();
