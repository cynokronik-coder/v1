/**
 * The one shape a service worker reply has.
 *
 * The dashboard and the worker are two programs that only ever talk over
 * chrome.runtime.sendMessage, and the worker can fail for boring reasons (a watch
 * that does not validate, a marketplace that refuses). Wrapping every reply, and
 * unwrapping it in exactly one place, is what stops the two sides from disagreeing
 * about whether a reply is `state` or `{ ok: true, result: state }`.
 */

export function ok(result) {
  return { ok: true, result };
}

export function fail(error) {
  const message = error?.message || String(error || "the service worker failed");
  return { ok: false, error: message };
}

/** Worker reply -> the value, or a thrown Error carrying the worker's message. */
export function unwrap(reply) {
  if (!reply || typeof reply !== "object" || typeof reply.ok !== "boolean") {
    throw new Error("unexpected reply from the service worker (is a different version installed?)");
  }
  if (reply.ok) return reply.result;
  throw new Error(reply.error || "the service worker reported an error");
}

/** Used by the worker's message listener: resolve -> ok, reject -> fail. */
export function replyWith(sendResponse, promise) {
  Promise.resolve(promise)
    .then((result) => sendResponse(ok(result)))
    .catch((error) => sendResponse(fail(error)));
  return true; // keep the message channel open for the async reply
}
