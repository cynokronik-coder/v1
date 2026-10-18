/**
 * The whole bridge over HTTP, as an MCP client and as the extension would use it.
 *
 * Run it against a local `wrangler dev` and against the deployed preview:
 *
 *   node tests/smoke.mjs http://127.0.0.1:8787 <token>
 *   node tests/smoke.mjs https://your-bridge <token>
 *
 * It writes and then consumes its own item, and it deletes nothing: the row it leaves
 * behind is acknowledged, so the extension will never show it.
 */

const base = (process.argv[2] || "").replace(/\/+$/, "");
const token = process.argv[3] || "";

if (!base || !/^[a-z0-9]{24,80}$/i.test(token)) {
  console.error("usage: node tests/smoke.mjs <base-url> <24+ char token>");
  process.exit(2);
}

let failures = 0;
const check = (label, condition, detail = "") => {
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
};

const call = async (path, init = {}) => {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
};

const rpc = (method, params = {}, id = 1) =>
  call(`/mcp/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

const health = await call("/health");
check("health answers", health.status === 200 && health.body?.service === "marketwatch-bridge", `HTTP ${health.status}`);

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke" } });
check("initialize", init.status === 200 && Boolean(init.body?.result?.serverInfo), JSON.stringify(init.body?.result?.serverInfo || {}));

const tools = await rpc("tools/list", {}, 2);
const names = (tools.body?.result?.tools || []).map((tool) => tool.name);
check("tools/list", names.includes("queue_reference") && names.includes("list_marketplaces"), names.join(", "));

const queued = await rpc(
  "tools/call",
  {
    name: "queue_reference",
    arguments: {
      product: "smoke test item",
      kind: "trade_in_quote",
      amount: 12.34,
      currency: "EUR",
      source: "bridge smoke test",
      note: "created by tests/smoke.mjs",
    },
  },
  3,
);
const receipt = JSON.parse(queued.body?.result?.content?.[0]?.text || "{}");
check("queue_reference", queued.status === 200 && Boolean(receipt.queued), receipt.queued || "");

const bad = await rpc("tools/call", { name: "queue_reference", arguments: { product: "x", kind: "price", amount: 5 } }, 4);
check("an ambiguous kind is refused", bad.body?.result?.isError === true);

const pull = await call(`/pull/${token}?limit=10`);
const items = pull.body?.items || [];
const mine = items.find((item) => item.id === receipt.queued);
check("pull returns the queued item", Boolean(mine), `${items.length} item(s)`);
check("the payload survived the round trip", mine?.payload?.amount === 12.34 && mine?.payload?.kind === "trade_in_quote", JSON.stringify(mine?.payload || {}));

const again = await call(`/pull/${token}?limit=10`);
check("a claimed item is not offered twice", !(again.body?.items || []).some((item) => item.id === receipt.queued));

const ack = await call(`/ack/${token}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ results: [{ id: receipt.queued, status: "rejected" }] }),
});
check("ack settles it", ack.status === 200 && ack.body?.settled === 1, JSON.stringify(ack.body));

const status = await call(`/status/${token}`);
check("status counts it", Number(status.body?.rejected) >= 1, JSON.stringify(status.body));

const unauth = await call(`/pull/0000000000000000000000000000000000000000`);
check("a token with nothing in it is just empty, not an error", unauth.status === 200 && (unauth.body?.items || []).length === 0);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
