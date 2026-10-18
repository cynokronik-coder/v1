/**
 * The bridge client. Everything here is about the failure the user will actually hit:
 * a wrong URL, a token from a previous install, a deployment that is asleep. Each one
 * has to turn into a sentence that says what to change.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BridgeError,
  bridgeFailure,
  bridgeMcpUrl,
  bridgeReady,
  createBridgeClient,
  normalizeBridgeToken,
  normalizeBridgeUrl,
} from "../src/core/bridge.js";

const TOKEN = "0123456789abcdef0123456789abcdef01234567";
const SETTINGS = { bridgeUrl: "https://bridge.test", bridgeToken: TOKEN, bridgeEnabled: true };

test("https is required, loopback http is allowed for local workerd", () => {
  assert.equal(normalizeBridgeUrl("https://bridge.test/"), "https://bridge.test");
  assert.equal(normalizeBridgeUrl("http://localhost:8787"), "http://localhost:8787");
  assert.throws(() => normalizeBridgeUrl("http://bridge.test"), /https/);
  assert.throws(() => normalizeBridgeUrl("not a url"), /is not a URL/);
  assert.equal(normalizeBridgeUrl(""), "");
});

test("a token is a token, not any string", () => {
  assert.equal(normalizeBridgeToken(TOKEN), TOKEN);
  assert.equal(normalizeBridgeToken(""), "");
  assert.throws(() => normalizeBridgeToken("short"), /24\+/);
  assert.throws(() => normalizeBridgeToken("has spaces in it 000000000000"), /24\+/);
});

test("readiness names the one thing that is missing", () => {
  assert.equal(bridgeReady(SETTINGS).ready, true);
  assert.match(bridgeReady({ ...SETTINGS, bridgeUrl: "" }).reason, /no bridge URL/);
  assert.match(bridgeReady({ ...SETTINGS, bridgeToken: "" }).reason, /no token/);
  assert.match(bridgeReady({ ...SETTINGS, bridgeEnabled: false }).reason, /switched off/);
});

test("the address to paste into a connector carries the token", () => {
  assert.equal(bridgeMcpUrl(SETTINGS), `https://bridge.test/mcp/${TOKEN}`);
  assert.equal(bridgeMcpUrl({ bridgeUrl: "", bridgeToken: TOKEN }), "");
});

test("pull validates what comes back and drops what it cannot use", async () => {
  const seen = [];
  const client = createBridgeClient({
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({
          items: [
            { id: "a", kind: "reference", payload: { product: "pixel 8", amount: 240 } },
            { id: "b", kind: "product", payload: { name: "Leica Q2" } },
            { id: "c", kind: "nonsense", payload: {} },
            { kind: "reference", payload: {} },
          ],
          dropped: ["one row was too large"],
        }),
        { status: 200 },
      );
    },
  });
  const result = await client.pull(SETTINGS, { limit: 5 });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].id, "a");
  assert.equal(result.dropped.length, 3);
  assert.match(seen[0], new RegExp(`/pull/${TOKEN}\\?limit=5$`));
});

test("a rejected token says the token is the problem", async () => {
  const client = createBridgeClient({ fetchImpl: async () => new Response("nope", { status: 401 }) });
  await assert.rejects(() => client.pull(SETTINGS), (error) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.kind, "auth");
    assert.match(error.message, /generate a new one/);
    return true;
  });
});

test("an unreachable bridge is a retry, not a crash", async () => {
  const client = createBridgeClient({
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(() => client.pull(SETTINGS), (error) => {
    assert.equal(error.kind, "network");
    assert.match(error.message, /could not be reached/);
    return true;
  });
});

test("a timeout is reported as a timeout", async () => {
  const client = createBridgeClient({
    timeoutMs: 5,
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  await assert.rejects(() => client.pull(SETTINGS), /did not answer/);
});

test("ack posts what happened, and settles nothing when there was nothing", async () => {
  const calls = [];
  const client = createBridgeClient({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: init?.body });
      return new Response(JSON.stringify({ ok: true, settled: 1 }), { status: 200 });
    },
  });
  assert.deepEqual(await client.ack(SETTINGS, []), { ok: true, settled: 0 });
  assert.equal(calls.length, 0);
  const settled = await client.ack(SETTINGS, [{ id: "a", status: "received" }]);
  assert.equal(settled.settled, 1);
  assert.deepEqual(JSON.parse(calls[0].body), { results: [{ id: "a", status: "received" }] });
});

test("status reports the queue counts", async () => {
  const client = createBridgeClient({
    fetchImpl: async () => new Response(JSON.stringify({ pending: 3, applied: 4, items: 9 }), { status: 200 }),
  });
  assert.deepEqual(await client.status(SETTINGS), { pending: 3, applied: 4, items: 9 });
});

test("a non-JSON answer is a format error, not a crash inside the dashboard", async () => {
  const client = createBridgeClient({ fetchImpl: async () => new Response("<html>hello</html>", { status: 200 }) });
  await assert.rejects(() => client.status(SETTINGS), /not JSON/);
});

test("a 500 keeps the status code in the message", () => {
  const error = bridgeFailure(500, "boom");
  assert.equal(error.status, 500);
  assert.match(error.message, /HTTP 500/);
});
