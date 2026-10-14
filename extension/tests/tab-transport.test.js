/**
 * The tab transport: make the marketplace request from the user's own tab.
 *
 * This is the fix for "leboncoin refuses the extension but works in my browser", so
 * what matters is: it runs the request in a real tab of the right host, it says so
 * when there is no such tab, and it never silently pretends a failed request worked.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { TabUnavailableError, createTabTransport, withTimeout } from "../src/core/tab-transport.js";
import { MarketplaceError } from "../src/core/adapters/base.js";

function fakeChrome({ tabs = [], result = { ok: true, status: 200, body: "<html>ok</html>", contentType: "text/html" }, scripts = [] } = {}) {
  const queries = [];
  const api = {
    tabs: {
      async query({ url }) {
        queries.push(url);
        // Chrome matches the pattern's host against the tab's hostname.
        const host = url.replace(/^https:\/\//, "").replace(/\/\*$/, "");
        return tabs.filter((tab) => tab.url && new URL(tab.url).hostname === host);
      },
    },
    scripting: {
      async executeScript(options) {
        scripts.push(options);
        if (typeof result === "function") return result(options);
        return [{ result }];
      },
    },
  };
  return { api, queries, scripts };
}

const LB_TAB = { id: 7, url: "https://www.leboncoin.fr/recherche?text=iphone", discarded: false };
const BM_TAB = { id: 9, url: "https://www.backmarket.fr/fr-fr", discarded: false };

test("availability is per host, and a discarded tab does not count", async () => {
  const { api } = fakeChrome({ tabs: [LB_TAB, { id: 8, url: "https://www.leboncoin.fr/x", discarded: true }, BM_TAB] });
  const transport = createTabTransport({ chrome: api });
  assert.equal(await transport.available(["www.leboncoin.fr"]), true);
  assert.equal(await transport.available(["leboncoin.fr"]), true, "the bare host pattern is tried too");
  assert.equal(await transport.available(["www.backmarket.fr"]), true);
  assert.equal(await transport.available(["www.vinted.fr"]), false);
});

test("the request runs inside the tab, in the page's own world", async () => {
  const { api, scripts } = fakeChrome({ tabs: [LB_TAB] });
  const transport = createTabTransport({ chrome: api });
  // A cross-origin call from the site's own tab: exactly what leboncoin's client does,
  // which is why the adapter passes its site domain as an extra host to look for.
  const response = await transport.fetchInTab(
    "https://api.leboncoin.fr/finder/search",
    { method: "POST", body: "{}" },
    { hosts: ["www.leboncoin.fr"] },
  );
  assert.equal(response.status, 200);
  assert.equal(response.body, "<html>ok</html>");
  assert.equal(response.headers.get("content-type"), "text/html");
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].target.tabId, 7);
  assert.equal(scripts[0].world, "MAIN");
  assert.equal(scripts[0].args[0], "https://api.leboncoin.fr/finder/search");
  assert.equal(scripts[0].args[1].method, "POST");
});

test("no open tab on that host is a clear instruction, not a mystery failure", async () => {
  const { api } = fakeChrome({ tabs: [] });
  const transport = createTabTransport({ chrome: api });
  await assert.rejects(() => transport.fetchInTab("https://www.leboncoin.fr/recherche", {}), (err) => {
    assert.ok(err instanceof TabUnavailableError);
    assert.match(err.message, /no open tab on www\.leboncoin\.fr/);
    assert.match(err.message, /open www\.leboncoin\.fr in a normal tab/);
    return true;
  });
});

test("a failure inside the page is reported as the real failure", async () => {
  const { api } = fakeChrome({
    tabs: [LB_TAB],
    result: { ok: false, error: "Failed to fetch" },
  });
  const transport = createTabTransport({ chrome: api });
  await assert.rejects(() => transport.fetchInTab("https://www.leboncoin.fr/recherche", {}), (err) => {
    assert.ok(err instanceof MarketplaceError);
    assert.ok(!(err instanceof TabUnavailableError));
    assert.match(err.message, /failed inside the page: Failed to fetch/);
    return true;
  });
});

test("if the first tab cannot be scripted, the next one is tried; then it gives up loudly", async () => {
  let call = 0;
  const { api } = fakeChrome({
    tabs: [LB_TAB, { id: 11, url: "https://www.leboncoin.fr/", discarded: false }],
    result: () => {
      call += 1;
      if (call === 1) throw new Error("Cannot access contents of the page");
      return [{ result: { ok: true, status: 200, body: "{}" } }];
    },
  });
  const transport = createTabTransport({ chrome: api });
  const response = await transport.fetchInTab("https://www.leboncoin.fr/recherche", {});
  assert.equal(response.status, 200);

  const { api: deadApi } = fakeChrome({
    tabs: [LB_TAB],
    result: () => {
      throw new Error("Cannot access contents of the page");
    },
  });
  const dead = createTabTransport({ chrome: deadApi });
  await assert.rejects(() => dead.fetchInTab("https://www.leboncoin.fr/recherche", {}), /could not run the request in any open tab/);
});

test("only https is allowed, and a hung tab cannot hang a whole scan", async () => {
  const { api } = fakeChrome({ tabs: [{ id: 1, url: "http://www.leboncoin.fr/", discarded: false }] });
  const transport = createTabTransport({ chrome: api });
  await assert.rejects(() => transport.fetchInTab("http://www.leboncoin.fr/recherche", {}), /only https is allowed/);

  const hanging = fakeChrome({ tabs: [LB_TAB], result: () => new Promise(() => {}) });
  const slow = createTabTransport({ chrome: hanging.api, timeoutMs: 5 });
  await assert.rejects(() => slow.fetchInTab("https://www.leboncoin.fr/recherche", {}), /did not answer within/);

  await assert.rejects(() => withTimeout(new Promise(() => {}), 5, "nope"), /nope/);
});

test("it refuses to run without the APIs it needs", () => {
  assert.throws(() => createTabTransport({ chrome: {} }), /tabs and scripting/);
});
