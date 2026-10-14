/** The worker<->dashboard contract, in one place. */

import test from "node:test";
import assert from "node:assert/strict";

import { fail, ok, replyWith, unwrap } from "../src/core/messages.js";

test("a reply round-trips a value, including falsy ones", () => {
  assert.deepEqual(unwrap(ok({ watches: [], alerts: [] })), { watches: [], alerts: [] });
  assert.equal(unwrap(ok(0)), 0);
  assert.equal(unwrap(ok(undefined)), undefined);
  assert.equal(unwrap(ok(false)), false);
});

test("a failed reply throws the worker's own message", () => {
  assert.throws(() => unwrap(fail(new Error("watch 'x' has no name"))), /watch 'x' has no name/);
  assert.throws(() => unwrap(fail("plain string")), /plain string/);
  assert.throws(() => unwrap({ ok: false }), /reported an error/);
});

test("a reply that is not an envelope is rejected loudly, not guessed at", () => {
  // This is the bug this module exists to prevent: a raw value where the dashboard
  // expects { ok, result } used to look like a successful empty answer.
  assert.throws(() => unwrap({ watches: [] }), /unexpected reply/);
  assert.throws(() => unwrap(null), /unexpected reply/);
  assert.throws(() => unwrap(undefined), /unexpected reply/);
  assert.throws(() => unwrap("state"), /unexpected reply/);
});

test("replyWith builds both envelopes and keeps the channel open", async () => {
  const replies = [];
  const kept = replyWith((reply) => replies.push(reply), Promise.resolve([1, 2]));
  assert.equal(kept, true);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(replies, [ok([1, 2])]);

  replyWith((reply) => replies.push(reply), Promise.reject(new Error("blocked")));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replies[1].ok, false);
  assert.match(replies[1].error, /blocked/);
});
