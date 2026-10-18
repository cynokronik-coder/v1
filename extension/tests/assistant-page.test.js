/**
 * The Assistant page, actually rendered in jsdom.
 *
 * The pure tests prove the parser and the worker side; this proves the page the user
 * meets: the instructions are on screen, pasting sends an import, the row that comes
 * back offers the right button for its kind, and a number with no product cannot be
 * applied until one is picked.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { JSDOM } from "jsdom";

import { fail, ok } from "../src/core/messages.js";

const HTML = readFileSync(new URL("../dashboard.html", import.meta.url), "utf8");

function baseState(over = {}) {
  return {
    watches: [],
    alerts: [],
    runs: {},
    history: [],
    catalog: [
      { id: "pixel-8", name: "Pixel 8", keyword: "pixel 8", category: "phones", enabled: true, resaleSource: "ebay" },
      { id: "iphone-13", name: "iPhone 13 (128 / 256 Go)", keyword: "iphone 13 128", category: "phones", enabled: true },
    ],
    opportunities: [],
    opportunityRuns: [],
    baselines: {},
    log: [],
    sources: [],
    providers: [],
    inbox: [],
    settings: { intervalMinutes: 15, bridgeEnabled: false, bridgeUrl: "", bridgeToken: "", bridgePollMinutes: 15 },
    nextRunAt: null,
    nextOpportunityRunAt: null,
    scanning: false,
    opportunityScanning: false,
    ...over,
  };
}

function inboxItem(over = {}) {
  return {
    id: "in-1",
    kind: "resale_ask",
    status: "pending",
    origin: "paste",
    keyword: "pixel 8",
    product: "pixel-8",
    productName: "Pixel 8",
    amount: 240,
    currency: "EUR",
    source: "eBay sold listing",
    url: null,
    note: "128 GB, good",
    observedAt: "2026-10-12",
    receivedAt: "2026-10-18T09:00:00.000Z",
    ...over,
  };
}

let caseId = 0;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0)).then(() => new Promise((r) => setTimeout(r, 0)));
const text = (doc, selector) => doc.querySelector(selector)?.textContent.trim();

/** Boot dashboard.js against a fresh document and a fake worker. */
async function open({ state = baseState(), onMessage } = {}) {
  const dom = new JSDOM(HTML, { url: "https://dashboard.invalid/dashboard.html" });
  const sent = [];
  const worker = {
    state,
    async handle(message) {
      sent.push(message);
      if (onMessage) {
        const reply = await onMessage(message, worker);
        if (reply !== undefined) return reply;
      }
      if (message.type === "getState") return worker.state;
      return { ok: true };
    },
  };

  const win = dom.window;
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.localStorage = win.localStorage;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        try {
          return ok(await worker.handle(message));
        } catch (err) {
          return fail(err);
        }
      },
    },
  };
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  await import(`../src/dashboard.js?assistant=${(caseId += 1)}`);
  await settle();
  globalThis.setInterval = realSetInterval;
  return { dom, sent, worker, doc: win.document };
}

test("the page explains both routes and holds the instructions the button copies", async () => {
  const { doc } = await open();
  doc.querySelector('.pagenav-tab[data-page="assistant"]').click();
  assert.equal(doc.querySelector("#page-assistant").hidden, false);
  assert.equal(doc.querySelector("#page-deals").hidden, true);

  const prompt = doc.querySelector("#assistant-prompt").textContent;
  assert.match(prompt, /trade_in_quote/);
  assert.match(prompt, /resale_ask/);
  assert.match(prompt, /"pixel 8"/, "the prompt lists the user's own products");
  assert.match(doc.querySelector("#page-assistant").textContent, /Connectors/);
  assert.match(text(doc, "#bridge-state"), /not collecting yet/);
});

test("pasting an answer sends it, and the row that comes back offers the right action", async () => {
  const { doc, sent } = await open({
    onMessage(message, worker) {
      if (message.type === "importAssistant") {
        worker.state = baseState({ inbox: [inboxItem()] });
        return { ok: true, added: 1, errors: [], warnings: [] };
      }
    },
  });
  doc.querySelector('.pagenav-tab[data-page="assistant"]').click();

  doc.querySelector("#assistant-text").value = '```json\n{"references": [{"product": "pixel 8", "kind": "resale_ask", "amount": 240}]}\n```';
  doc.querySelector("#assistant-import").click();
  await settle();

  const message = sent.find((entry) => entry.type === "importAssistant");
  assert.ok(message, "the import is sent to the worker");
  assert.match(message.text, /resale_ask/);

  const row = doc.querySelector(".inbox-row");
  assert.ok(row, "the imported row is rendered");
  assert.match(row.querySelector(".inbox-line").textContent, /asking price: 240\.00 EUR for "pixel 8"/);
  assert.match(row.querySelector(".inbox-meta").textContent, /what a buyer is charged/);
  assert.equal(row.querySelector(".inbox-apply").textContent, "Use as the resale price");
  assert.equal(row.querySelector(".inbox-apply").disabled, false);
  assert.equal(row.querySelector(".inbox-product").hidden, true);
  assert.equal(text(doc, "#badge-assistant"), "1");
});

test("applying a row sends the decision to the worker", async () => {
  const { doc, sent } = await open({
    state: baseState({ inbox: [inboxItem()] }),
    onMessage(message, worker) {
      if (message.type === "decideInbox") {
        worker.state = baseState({ inbox: [inboxItem({ status: "applied" })] });
        return { ok: true, item: inboxItem({ status: "applied" }) };
      }
    },
  });
  doc.querySelector('.pagenav-tab[data-page="assistant"]').click();
  doc.querySelector(".inbox-apply").click();
  await settle();
  assert.deepEqual(
    sent.filter((entry) => entry.type === "decideInbox").at(-1),
    { type: "decideInbox", id: "in-1", action: "apply" },
  );
  assert.equal(doc.querySelectorAll(".inbox-row").length, 0, "an applied row leaves the queue");
  assert.equal(doc.querySelector("#inbox-empty").hidden, false);
});

test("a payout row says it is a payout, and is applied through the payout line", async () => {
  const { doc } = await open({
    state: baseState({
      inbox: [inboxItem({ kind: "trade_in_quote", amount: 385, source: "Back Market buyback page" })],
    }),
  });
  doc.querySelector('.pagenav-tab[data-page="assistant"]').click();
  const row = doc.querySelector(".inbox-row");
  assert.equal(row.querySelector(".inbox-apply").textContent, "Use for the payout line");
  assert.match(row.querySelector(".inbox-meta").textContent, /a payout, not a resale price/);
  assert.match(row.querySelector(".inbox-line").textContent, /payout quote: 385\.00 EUR/);
});

test("a number with no catalogue product cannot be applied until one is picked", async () => {
  const { doc, sent } = await open({
    state: baseState({
      inbox: [inboxItem({ id: "in-9", keyword: "leica q2", product: null, productName: null, source: "eBay", amount: 2400 })],
    }),
    onMessage(message, worker) {
      if (message.type === "attachInbox") {
        worker.state = baseState({ inbox: [inboxItem({ id: "in-9", keyword: "leica q2", product: "pixel-8", productName: "Pixel 8" })] });
        return { ok: true, item: inboxItem({ id: "in-9", product: "pixel-8" }) };
      }
    },
  });
  doc.querySelector('.pagenav-tab[data-page="assistant"]').click();

  const row = doc.querySelector(".inbox-row");
  assert.equal(row.querySelector(".inbox-apply").disabled, true, "no guessing which product it meant");
  const select = row.querySelector(".inbox-product");
  assert.equal(select.hidden, false);
  assert.equal(select.options[0].value, "");

  select.value = "pixel-8";
  select.dispatchEvent(new select.ownerDocument.defaultView.Event("change"));
  await settle();
  assert.deepEqual(
    sent.filter((entry) => entry.type === "attachInbox").at(-1),
    { type: "attachInbox", id: "in-9", product: "pixel-8" },
  );
});

test("generating a token saves it, so the connector address can be copied", async () => {
  const { doc, sent } = await open();
  doc.querySelector('.pagenav-tab[data-page="assistant"]').click();
  doc.querySelector("#bridge-url").value = "https://bridge.test";
  doc.querySelector("#bridge-generate").click();
  await settle();

  const saved = sent.filter((entry) => entry.type === "setSettings").at(-1);
  assert.ok(saved, "token generation saves the settings");
  assert.match(saved.settings.bridgeToken, /^[0-9a-f]{48}$/);
  assert.equal(saved.settings.bridgeUrl, "https://bridge.test");
  assert.equal(doc.querySelector("#bridge-token").value, saved.settings.bridgeToken);
  // Generating a token is asking for the bridge: without this, the next step (Check now)
  // answers "switched off" and the page's own instructions lead into a wall.
  assert.equal(saved.settings.bridgeEnabled, true);
  assert.equal(doc.querySelector("#bridge-enabled").checked, true);
});

test("a saved bridge says it is ready instead of asking again", async () => {
  const { doc } = await open({
    state: baseState({
      settings: {
        intervalMinutes: 15,
        bridgeEnabled: true,
        bridgeUrl: "https://bridge.test",
        bridgeToken: "0123456789abcdef0123456789abcdef01234567",
        bridgePollMinutes: 5,
      },
    }),
  });
  doc.querySelector('.pagenav-tab[data-page="assistant"]').click();
  assert.match(text(doc, "#bridge-state"), /ready · checking every 5 minute\(s\)/);
  assert.equal(doc.querySelector("#bridge-enabled").checked, true);
});
