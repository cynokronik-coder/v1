/**
 * Serves the extension's dashboard over HTTP with a mock service worker, so the UI
 * can be looked at (and clicked through) in a normal browser tab without installing
 * the extension.
 *
 *   node tools/dashboard-preview/server.mjs [port]
 *
 * Nothing in `extension/` is modified: this rewrites dashboard.html on the way out
 * to add one <script> that installs a fake `chrome.runtime.sendMessage`, and serves
 * everything else straight from disk. The mock is tools/dashboard-preview/mock-worker.js
 * and it uses the real source/provider registries, so the pages show the engine's
 * actual data.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const EXTENSION = resolve(HERE, "../../extension");
const PORT = Number(process.argv[2] || process.env.PORT || 3000);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const body = (path) => readFile(path);
// HTML and JS are rewritten or handed to the browser as text, so they are read as
// text; everything else is streamed as bytes.
const text = (path) => readFile(path, "utf8");

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  const path = url.pathname === "/" ? "/dashboard.html" : url.pathname;

  try {
    if (path === "/dashboard.html") {
      const html = await text(join(EXTENSION, "dashboard.html"));
      // The mock has to be installed before the dashboard module runs.
      const injected = html.replace(
        '<script type="module" src="src/dashboard.js"></script>',
        '<script type="module" src="/__preview/mock-worker.js"></script>\n    <script type="module" src="src/dashboard.js"></script>',
      );
      response.writeHead(200, { "content-type": TYPES[".html"] });
      response.end(injected);
      return;
    }
    if (path === "/favicon.ico") {
      // The dashboard sets no favicon; serve the icon so the console stays clean.
      response.writeHead(200, { "content-type": TYPES[".png"] });
      response.end(await body(join(EXTENSION, "icons/icon48.png")));
      return;
    }
    if (path === "/__preview/mock-worker.js") {
      response.writeHead(200, { "content-type": TYPES[".js"] });
      response.end(await text(join(HERE, "mock-worker.js")));
      return;
    }
    // Everything else is the extension directory, and only that directory.
    const target = resolve(join(EXTENSION, normalize(path)));
    if (!target.startsWith(EXTENSION)) {
      response.writeHead(403).end("no");
      return;
    }
    const type = TYPES[extname(target)] || "application/octet-stream";
    response.writeHead(200, { "content-type": type });
    response.end(type.startsWith("text/") ? await text(target) : await body(target));
  } catch (error) {
    response.writeHead(error.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain" });
    response.end(`${path}: ${error.code || error.message}`);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`dashboard preview on http://0.0.0.0:${PORT}/dashboard.html`);
});
