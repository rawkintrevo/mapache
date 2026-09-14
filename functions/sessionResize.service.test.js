"use strict";
const assert = require("node:assert/strict");
const {createSessionResizeService, assertNoActiveResize, CLAIM_TIMEOUT_MS} = require("./sessionResize.service");

function fixture() {
  let session = {ownerUid: "u", status: "running", imageKey: "pi-chrome", image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome", agentUiVersion: "pi-web-ui-v1"};
  let time = 1000;
  let calls = 0;
  let run = async () => ({status: "running"});
  const snapshot = () => ({id: "s", exists: !!session, ref, data: () => ({...session})});
  const ref = {get: async () => snapshot()};
  // Serialize transactions, including concurrent delivery tests.
  let lock = Promise.resolve();
  const db = {runTransaction: (fn) => {
    const result = lock.then(() => fn({get: async () => snapshot(), update: (_ref, update) => { session = {...session, ...update}; }}));
    lock = result.catch(() => {});
    return result;
  }};
  const service = createSessionResizeService({
    admin: {firestore: {FieldValue: {serverTimestamp: () => time}}}, db,
    requireSession: async (uid) => {if (uid !== "u") throw new Error("forbidden"); return {sessionRef: ref};},
    normalizeRequestedSessionResources: (resources) => {if (!resources.cpu) throw new Error("invalid_session_resources"); return resources;},
    resizeSession: async (...args) => {calls++; return run(...args);},
    now: () => time,
  });
  return {service, get: () => session, set: (patch) => {session = {...session, ...patch};}, calls: () => calls,
    advance: () => {time += CLAIM_TIMEOUT_MS;}, run: (fn) => {run = fn;},
    event: () => {const data = {...session}; return {params: {workspaceId: "w"}, data: {after: {...snapshot(), data: () => data}}};}};
}

(async () => {
  const resources = {cpu: "2", memory: "8Gi"};
  const f = fixture();
  await assert.rejects(f.service.enqueueResize("other", "w", "s", resources), /forbidden/);
  await assert.rejects(f.service.enqueueResize("u", "w", "s", {}), /invalid_session_resources/);
  const accepted = await f.service.enqueueResize("u", "w", "s", resources);
  assert.equal(accepted.resizeOperationState, "queued");
  assert.equal(f.calls(), 0, "request must return before any stop/provision work");
  const id = f.get().resizeOperationId;
  await f.service.enqueueResize("u", "w", "s", resources);
  assert.equal(f.get().resizeOperationId, id, "same pending request is idempotent");
  await assert.rejects(f.service.enqueueResize("u", "w", "s", {cpu: "4", memory: "8Gi"}), /session_resize_in_progress/);
  assert.throws(() => assertNoActiveResize(f.get()), /session_resize_in_progress/);
  const event = f.event();
  let release;
  f.run(async (uid, workspace, session, requested) => {
    assert.deepEqual([uid, workspace, session, requested], ["u", "w", "s", resources]);
    await new Promise((resolve) => {release = resolve;});
    return {status: "running"};
  });
  const first = f.service.resizeQueuedSession(event);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.service.resizeQueuedSession(event), /session_resize_worker_active/);
  release();
  await first;
  await f.service.resizeQueuedSession(event);
  assert.equal(f.calls(), 1, "duplicate delivery cannot execute twice");
  assert.equal(f.get().resizeOperationState, "completed");
  assertNoActiveResize(f.get());

  for (const result of ["throw", "returned_failure"]) {
    const failed = fixture();
    failed.run(async () => {
      if (result === "throw") throw {publicMessage: "session_stop_failed"};
      return {status: "provision_failed", lastError: "cloud_run_failed"};
    });
    await failed.service.enqueueResize("u", "w", "s", resources);
    await failed.service.resizeQueuedSession(failed.event());
    assert.equal(failed.get().resizeOperationState, "failed");
    assert.equal(failed.get().resizeOperationError, result === "throw" ? "session_stop_failed" : "cloud_run_failed");
    await failed.service.enqueueResize("u", "w", "s", resources);
    assert.equal(failed.get().resizeOperationState, "queued");
  }
  const timedOut = fixture();
  await timedOut.service.enqueueResize("u", "w", "s", resources);
  const retry = timedOut.event();
  timedOut.set({resizeOperationState: "running", resizeOperationStartedAt: 1000});
  timedOut.advance();
  await timedOut.service.resizeQueuedSession(retry);
  assert.equal(timedOut.calls(), 1, "retry can recover after the previous invocation must have timed out");
  const stale = fixture();
  await stale.service.enqueueResize("u", "w", "s", resources);
  const oldEvent = stale.event();
  stale.set({resizeOperationId: "replacement"});
  await stale.service.resizeQueuedSession(oldEvent);
  assert.equal(stale.calls(), 0);
  console.log("session resize queue/worker tests passed");
})().catch((error) => {console.error(error); process.exitCode = 1;});
