/**
 * The things that make an unpacked extension load at all, and the rules Chrome will
 * refuse it for. Cheap checks that catch the failure mode where all the logic is
 * green but the extension will not install.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { MARKETPLACES } from "../src/core/models.js";
import { SOURCES } from "../src/core/sources.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const read = (path) => readFileSync(join(root, path), "utf8");

test("the manifest is a valid MV3 manifest with the files it points at", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.name && manifest.version && manifest.description);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.background.type, "module", "the worker is an ES module");
  for (const path of [manifest.background.service_worker, "dashboard.html", "dashboard.css", "src/dashboard.js"]) {
    assert.ok(existsSync(join(root, path)), `${path} is missing`);
  }
});

test("every icon exists, is a PNG, and is the size it claims", () => {
  const icons = { ...manifest.icons, ...manifest.action.default_icon };
  for (const [size, path] of Object.entries(icons)) {
    const file = join(root, path);
    assert.ok(existsSync(file), `${path} is missing`);
    const bytes = readFileSync(file);
    assert.equal(bytes.subarray(1, 4).toString(), "PNG", `${path} is not a PNG`);
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    assert.equal(width, Number(size), `${path} is ${width}px wide, expected ${size}`);
    assert.equal(height, Number(size), `${path} is ${height}px tall, expected ${size}`);
    assert.ok(statSync(file).size < 40_000, `${path} is too big to ship`);
  }
  assert.ok(manifest.icons["128"], "Chrome needs a 128px icon");
});

test("permissions are the minimum needed, and every host is https", () => {
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["alarms", "cookies", "notifications", "scripting", "storage", "tabs"],
  );
  assert.ok(manifest.permissions.length <= 6, "keep the permission list short and justifiable");
  for (const pattern of manifest.host_permissions) {
    assert.match(pattern, /^https:\/\/[^/]+\/\*$/, `${pattern} must be an https host pattern`);
  }
  // Every marketplace the registry can reach must have a host permission, or the
  // adapter fails silently in the browser for a reason no unit test would see.
  for (const source of SOURCES) {
    for (const host of source.hosts || []) {
      assert.ok(
        manifest.host_permissions.some((pattern) => patternCovers(pattern, host)),
        `no host permission for ${host} (${source.id})`,
      );
    }
  }
  // And the data providers, or their keys would be useless.
  for (const host of ["api.apify.com", "serpapi.com", "api.brightdata.com", "api.keepa.com"]) {
    assert.ok(manifest.host_permissions.some((pattern) => patternCovers(pattern, host)), `no host permission for ${host}`);
  }
});

/** Does a Chrome host pattern actually cover this host? `*.a.fr` covers `x.a.fr`. */
function patternCovers(pattern, host) {
  const target = String(pattern).replace(/^https:\/\//, "").replace(/\/\*$/, "");
  if (target.startsWith("*.")) {
    const suffix = target.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === target;
}

test("nothing in the extension loads remote code or uses eval (MV3 forbids both)", () => {
  const files = ["dashboard.html", "dashboard.css", "src/background.js", "src/dashboard.js", "src/core/analyzer.js", "src/core/catalog.js", "src/core/models.js", "src/core/notify.js", "src/core/opportunity.js", "src/core/opportunity-scan.js", "src/core/providers.js", "src/core/scan.js", "src/core/sources.js", "src/core/storage.js", "src/core/tab-transport.js", "src/core/trends.js", "src/core/adapters/base.js", "src/core/adapters/html-extract.js", "src/core/adapters/index.js", "src/core/adapters/page-source.js", "src/core/adapters/vinted.js", "src/core/adapters/leboncoin.js", "src/core/adapters/ebay.js", "src/core/adapters/backmarket.js", "src/core/adapters/mock.js", "src/ui/format.js", "src/ui/views.js", "src/ui/watch-form.js"];
  for (const path of files) {
    const text = read(path);
    assert.ok(!/\beval\s*\(/.test(text), `${path} uses eval`);
    assert.ok(!/new\s+Function\s*\(/.test(text), `${path} uses new Function`);
    assert.ok(!/import\s*\(\s*["'`]https?:/.test(text), `${path} imports remote code`);
    assert.ok(!/<script[^>]+src="https?:/.test(text), `${path} loads a remote script`);
  }
  // dashboard.html may only load local assets
  const html = read("dashboard.html");
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    assert.ok(!/^https?:/.test(match[1]), `dashboard.html loads a remote asset: ${match[1]}`);
  }
  assert.ok(!/onclick=|onload=|onerror=/i.test(html), "no inline event handlers (CSP)");
});

test("the dashboard offers exactly the marketplaces the scanner supports", () => {
  const mjs = read("src/dashboard.js");
  const listed = mjs.match(/const MARKETPLACE_OPTIONS = (\[[\s\S]*?\]);/);
  assert.ok(listed, "the marketplace dropdown should list the real marketplaces");
  assert.deepEqual(JSON.parse(listed[1]), MARKETPLACES);
});

test("every element the dashboard reaches for exists in the page", () => {
  const mjs = read("src/dashboard.js");
  const html = read("dashboard.html");
  // `$("id")` lookups and the template ids, so a renamed panel cannot silently
  // become `null` in a code path no test happens to render.
  const ids = new Set();
  for (const match of mjs.matchAll(/\$\("([a-z0-9-]+)"\)/gi)) ids.add(match[1]);
  for (const match of mjs.matchAll(/\$\("([a-z0-9-]+)"\)\.content/g)) ids.add(match[1]);
  assert.ok(ids.size >= 20, `expected the dashboard to reach for many elements, found ${ids.size}`);
  for (const id of ids) {
    assert.match(html, new RegExp(`id="${id}"`), `dashboard.html has no #${id}`);
  }
});

test("every page the navigation offers exists, and every page the worker renders too", () => {
  const mjs = read("src/dashboard.js");
  const html = read("dashboard.html");
  const pages = [...html.matchAll(/data-page="([a-z]+)"/g)].map((match) => match[1]);
  assert.ok(pages.length >= 5, "Deals, Opportunities, History, Sources, Settings");
  for (const page of pages) assert.match(html, new RegExp(`id="page-${page}"`), `no #page-${page}`);
  for (const match of mjs.matchAll(/"(page-[a-z]+)"/g)) {
    assert.ok(html.includes(`id="${match[1]}"`), `dashboard.js knows about ${match[1]}, which is not in the page`);
  }
});
