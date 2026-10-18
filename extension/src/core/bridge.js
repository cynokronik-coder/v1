/**
 * The client half of the live bridge.
 *
 * An extension can never be *sent* anything - no port is listening in an MV3 worker -
 * so the bridge is a queue the extension **pulls**. This module is the only place that
 * knows the wire format: URL building, the timeout, and the mapping from "the server
 * said no" to a sentence that tells the user what to change.
 *
 * It is not a transport for trust: everything it returns is still validated by
 * `core/assistant.js` before it can reach the inbox. A compromised or broken bridge can
 * waste the user's time; it cannot write a price into a verdict.
 *
 * `fetchImpl` is injected so the whole thing is testable in node without a server.
 */

export class BridgeError extends Error {
  constructor(message, { status = 0, kind = "bridge" } = {}) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.kind = kind;
  }
}

export const BRIDGE_POLL_DEFAULT = 15;
export const BRIDGE_TIMEOUT_MS = 15000;

/**
 * A bridge URL, normalised. HTTPS only, because the endpoint is on the public
 * internet and carries a token; loopback http stays allowed so the worker can be
 * exercised with `wrangler dev` before anything is deployed.
 */
export function normalizeBridgeUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new BridgeError(`'${text}' is not a URL: it should look like https://your-bridge.example.workers.dev`);
  }
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new BridgeError("the bridge URL must start with https:// (http is only accepted for localhost)");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The token is a path segment, so it is validated rather than pasted through. */
export function normalizeBridgeToken(value) {
  const token = String(value ?? "").trim();
  if (!token) return "";
  if (!/^[a-z0-9]{24,80}$/i.test(token)) {
    throw new BridgeError("that token does not look like a bridge token (24+ letters and digits), generate one below");
  }
  return token;
}

export function bridgeSettings(settings = {}) {
  try {
    return {
      base: normalizeBridgeUrl(settings.bridgeUrl),
      token: normalizeBridgeToken(settings.bridgeToken),
    };
  } catch (error) {
    return { base: "", token: "", error: error.message };
  }
}

/** Ready means: switched on, a URL and a token. Anything missing says which. */
export function bridgeReady(settings = {}) {
  const { base, token, error } = bridgeSettings(settings);
  if (error) return { ready: false, reason: error, base, token };
  if (settings.bridgeEnabled === false) return { ready: false, reason: "the live bridge is switched off in Settings", base, token };
  if (!base) return { ready: false, reason: "no bridge URL yet: deploy or paste one, then press Save", base, token };
  if (!token) return { ready: false, reason: "no token yet: press Generate a token, then paste it into the connector", base, token };
  return { ready: true, reason: "", base, token };
}

/** The address to paste into ChatGPT, with the token in the path. */
export function bridgeMcpUrl(settings = {}) {
  const { base, token } = bridgeSettings(settings);
  if (!base || !token) return "";
  return `${base}/mcp/${token}`;
}

export function endpoint(settings, path) {
  const { base, token, error } = bridgeSettings(settings);
  if (error) throw new BridgeError(error);
  if (!base) throw new BridgeError("no bridge URL is set");
  if (!token) throw new BridgeError("no bridge token is set");
  return `${base}${path}/${token}`;
}

export function pullUrl(settings, { limit = 20 } = {}) {
  const url = endpoint(settings, "/pull");
  return `${url}?limit=${encodeURIComponent(String(limit))}`;
}

export function ackUrl(settings) {
  return endpoint(settings, "/ack");
}

export function statusUrl(settings) {
  return endpoint(settings, "/status");
}

/** One place where an HTTP status becomes something worth reading. */
export function bridgeFailure(status, body = "") {
  const detail = String(body || "").trim().slice(0, 200);
  if (status === 0) {
    return new BridgeError(
      "the bridge could not be reached (offline, wrong URL, or the deployment is asleep) - it will be tried again next interval",
      { status, kind: "network" },
    );
  }
  if (status === 401 || status === 403 || status === 404) {
    return new BridgeError(
      "the bridge does not know this token: generate a new one here, paste it into the connector again, then save",
      { status, kind: "auth" },
    );
  }
  if (status === 429) {
    return new BridgeError("the bridge is rate-limiting this token: wait a minute before trying again", { status, kind: "rate" });
  }
  if (status >= 500) {
    return new BridgeError(`the bridge failed (HTTP ${status})${detail ? `: ${detail}` : ""}`, { status, kind: "server" });
  }
  return new BridgeError(`the bridge refused that (HTTP ${status})${detail ? `: ${detail}` : ""}`, { status, kind: "request" });
}

function validateItems(payload) {
  const list = Array.isArray(payload?.items) ? payload.items : [];
  const items = [];
  const dropped = [];
  for (const raw of list) {
    const kind = raw?.kind === "product" ? "product" : raw?.kind === "reference" ? "reference" : null;
    if (!raw?.id || !kind || !raw.payload || typeof raw.payload !== "object") {
      dropped.push(raw?.id ? `item ${raw.id} had no usable payload` : "an item arrived with no id");
      continue;
    }
    items.push({ id: String(raw.id), kind, payload: raw.payload, source: raw.source || null, createdAt: raw.createdAt || null });
  }
  if (Array.isArray(payload?.dropped) && payload.dropped.length) {
    dropped.push(...payload.dropped.map(String));
  }
  return { items, dropped };
}

export function createBridgeClient({ fetchImpl = globalThis.fetch, timeoutMs = BRIDGE_TIMEOUT_MS } = {}) {
  async function request(url, init = {}) {
    if (typeof fetchImpl !== "function") throw new BridgeError("this environment has no fetch");
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        signal: controller?.signal,
        // The bridge is stateless and token-scoped; cookies would be a bug, not a feature.
        credentials: "omit",
        cache: "no-store",
      });
    } catch (error) {
      const aborted = error?.name === "AbortError";
      throw new BridgeError(
        aborted
          ? `the bridge did not answer within ${Math.round(timeoutMs / 1000)}s - it will be tried again next interval`
          : `the bridge could not be reached (${String(error?.message || error)})`,
        { status: 0, kind: "network" },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
    const body = await response.text().catch(() => "");
    if (!response.ok) throw bridgeFailure(response.status, body);
    try {
      return body ? JSON.parse(body) : {};
    } catch {
      throw new BridgeError("the bridge answered with something that is not JSON", { status: response.status, kind: "format" });
    }
  }

  return {
    /** What is waiting. Never throws for an empty queue. */
    async pull(settings, { limit = 20 } = {}) {
      const payload = await request(pullUrl(settings, { limit }));
      return validateItems(payload);
    },

    /** Tell the bridge what happened to each item, so it is not offered twice. */
    async ack(settings, results = []) {
      if (!results.length) return { ok: true, settled: 0 };
      const payload = await request(ackUrl(settings), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ results: results.slice(0, 50) }),
      });
      return { ok: payload?.ok !== false, settled: Number(payload?.settled ?? results.length) };
    },

    /** How many are waiting, and whether the token is accepted at all. */
    async status(settings) {
      const payload = await request(statusUrl(settings));
      return {
        pending: Number(payload?.pending ?? 0),
        applied: Number(payload?.applied ?? 0),
        items: Number(payload?.items ?? 0),
      };
    },
  };
}

export const __testing = { validateItems };
