"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createMutationBarrier} = require("./mutationBarrier");

test("closes admission, waits for included writers, and reopens after a checkpoint", async () => {
  const barrier = createMutationBarrier({timeoutMs: 100});
  const writer = barrier.enter("shell");
  const closing = barrier.begin({reason: "checkpoint"});
  await assert.rejects(Promise.resolve().then(() => barrier.enter("terminal")), {code: "checkpoint_barrier_pending"});
  let closed = false;
  closing.then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  barrier.leave(writer);
  await closing;
  assert.equal(barrier.snapshot().state, "closed");
  barrier.reopen();
  assert.equal(barrier.enter("next").label, "next");
});

test("a stalled writer blocks a strict checkpoint and leaves admission closed", async () => {
  const barrier = createMutationBarrier({timeoutMs: 5});
  barrier.enter("long-running-shell");
  await assert.rejects(barrier.begin({reason: "checkpoint"}), {code: "checkpoint_barrier_timeout"});
  assert.equal(barrier.snapshot().state, "blocked");
  await assert.rejects(Promise.resolve().then(() => barrier.enter("another")), {code: "checkpoint_barrier_pending"});
});

test("a runner-owned write reserves the prompt boundary while it is active", () => {
  const barrier = createMutationBarrier();
  const token = barrier.enter("git_commit");
  assert.throws(() => barrier.assertQuiescent("agent_prompt"), {code: "checkpoint_barrier_pending"});
  barrier.leave(token);
  assert.equal(barrier.assertQuiescent("agent_prompt"), true);
});
