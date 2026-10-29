"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {Firestore} = require("firebase-admin/firestore");
const {createAutomationOomRecoveryService, nextResources, readOomEvidence} = require("./automationOomRecovery.service");
const {createAutomationCleanupService} = require("./automationCleanup.service");
const {automationCloudRunServiceId} = require("./provisioning.helpers");
const {retryEligibility} = require("./automationRetry.service");

const serializer = new Firestore({projectId: "oom-tests"})._serializer;
const timestamp = "2026-10-22T20:00:00.000Z";
const admin = {firestore: {FieldValue: {serverTimestamp: () => timestamp}}};

function harness(overrides = {}) {
  const data = new Map();
  const calls = [];
  const db = {
    collection: (path) => ({doc: (id) => ref(`${path}/${id}`)}),
    runTransaction: async (fn) => {
      const writes = [];
      const result = await fn({
        get: (r) => { assert.equal(writes.length, 0, "Firestore reads precede writes"); return r.get(); },
        set: (r, v) => writes.push(() => { serializer.encodeFields(v); data.set(r.path, v); }),
        update: (r, v) => writes.push(() => r.update(v)),
      });
      for (const write of writes) await write();
      return result;
    },
  };
  function ref(path) {
    return {path, id: path.split("/").at(-1),
      get: async () => ({exists: data.has(path), id: path.split("/").at(-1), data: () => data.get(path)}),
      update: async (v) => { serializer.encodeFields(v); data.set(path, {...data.get(path), ...v}); },
    };
  }
  const run = {
    runId: "ticket-one", ownerUid: "owner", workspaceId: "target", ticketId: "one", automationId: "ticket-one",
    sessionId: "auto-ticket-one", status: "provisioning", cleanupState: "pending", createdAt: timestamp,
    snapshot: {name: "Workspace request", prompt: "Read context", cron: "ticket", timezone: "UTC",
      definitionRevision: 1, allowParallelWithMain: true, modelSelection: null, resources: {cpu: "1", memory: "2Gi"}},
    workspaceRunRequest: {targetWorkspaceId: "target", actor: {type: "user", id: "owner"},
      source: {type: "workspace_agent", id: "source"}, triggerKind: "http_ticket", instructions: "Read context",
      contextSnapshotRefs: [], resources: {cpu: "1", memory: "2Gi"}, sinks: [{kind: "ticket_result"}]},
    sinkDelivery: {"ticket_result:0": {state: "pending", attempts: 0, lastError: null}},
    chromeProfileSeed: {seedVersion: "immutable-seed"},
    ...overrides.run,
  };
  data.set("automationRuns/ticket-one", run);
  data.set("workspaces/target", {ownerUid: "owner", ...overrides.workspace});
  data.set("workspaceTickets/one", {ownerUid: "owner", workspaceId: "target", runId: run.runId,
    status: "provisioning", ...overrides.ticket});
  data.set("workspaces/target/sessions/auto-ticket-one", {
    serviceId: automationCloudRunServiceId(run.runId), resources: run.snapshot.resources, ...overrides.session,
  });
  const sessionCollection = (wid) => db.collection(`workspaces/${wid}/sessions`);
  const service = createAutomationOomRecoveryService({db, admin, sessionCollection,
    readOomEvidence: overrides.readOomEvidence || (async () => ({timestamp, revision: "revision-1"})),
  });
  const cleanup = createAutomationCleanupService({db, admin, sessionCollection,
    inspectOom: service.inspectRun, retryOomAfterDeletion: service.retryAfterDeletion,
    deleteSessionService: async () => {
      calls.push("delete");
      if (overrides.duringDeletion) await overrides.duringDeletion(data);
      return {serviceAbsent: overrides.serviceAbsent !== false};
    },
    releaseAutomationSlot: async () => { calls.push("release"); return {released: true}; },
  });
  return {data, db, run, service, cleanup, calls};
}

test("startup OOM cleanup queues one larger attempt on the same ticket and preserves Chrome", async () => {
  const h = harness();
  assert.equal(await h.service.inspectRun(h.run.runId), true);
  await h.cleanup.cleanupAutomationRun(h.run.runId);
  const previous = h.data.get("automationRuns/ticket-one");
  const ticket = h.data.get("workspaceTickets/one");
  const next = h.data.get(`automationRuns/${ticket.runId}`);
  assert.equal(previous.status, "failed");
  assert.equal(previous.cleanupState, "complete");
  assert.equal(previous.provisioningErrorCode, "automation_provisioning_oom");
  assert.equal(ticket.status, "queued");
  assert.equal(ticket.errorCode, null);
  assert.equal(next.status, "queued");
  assert.deepEqual(next.snapshot.resources, {cpu: "1", memory: "4Gi"});
  assert.deepEqual(next.workspaceRunRequest.resources, next.snapshot.resources);
  assert.deepEqual(next.chromeProfileSeed, h.run.chromeProfileSeed);
  assert.equal(next.retryOfRunId, h.run.runId);
  assert.equal(next.oomRetryCount, 1);
  assert.equal(next.executionStartedAt, undefined);
  assert.deepEqual(h.calls, ["delete", "release"]);
  await h.cleanup.cleanupAutomationRun(h.run.runId);
  await h.service.retryAfterDeletion(h.run.runId);
  assert.equal([...h.data.keys()].filter((key) => key.startsWith("automationRuns/")).length, 2);
  assert.equal(h.data.get("workspaceTickets/one").runId, ticket.runId);
});

for (const state of [{status: "running", executionStartedAt: timestamp},
  {status: "provisioning", executionStartedAt: timestamp}]) {
  test(`execution claim prevents replay even in ${state.status}`, async () => {
    const h = harness({run: state});
    await h.service.inspectRun(h.run.runId);
    await h.cleanup.cleanupAutomationRun(h.run.runId);
    const ticket = h.data.get("workspaceTickets/one");
    assert.equal(ticket.runId, h.run.runId);
    assert.equal(ticket.status, "failed");
    assert.equal(ticket.errorCode, "automation_execution_oom");
    assert.equal(h.data.get("automationRuns/ticket-one").oomRetryRunId, undefined);
    assert.equal(retryEligibility({...h.data.get("automationRuns/ticket-one"), retryPolicy: "safe", replaySafe: true,
      maximumRetries: 2}).eligible, false);
  });
}

test("a late execution claim during deletion converts recovery into a caller-visible execution OOM", async () => {
  const h = harness({duringDeletion: async (data) => {
    const key = "automationRuns/ticket-one";
    data.set(key, {...data.get(key), executionStartedAt: timestamp});
  }});
  await h.service.inspectRun(h.run.runId);
  await h.cleanup.cleanupAutomationRun(h.run.runId);
  assert.equal(h.data.get("workspaceTickets/one").errorCode, "automation_execution_oom");
  assert.equal(h.data.get("workspaceTickets/one").runId, h.run.runId);
});

test("repeated startup OOMs stop at the catalog ceiling and return a terminal error on the original ticket", async () => {
  const h = harness();
  let id = h.run.runId;
  for (let attempt = 0; attempt < 3; attempt++) {
    const runKey = `automationRuns/${id}`;
    const run = h.data.get(runKey);
    const sessionId = `auto-${id}`;
    h.data.set(runKey, {...run, status: "provisioning", sessionId});
    h.data.set(`workspaces/target/sessions/${sessionId}`, {
      serviceId: automationCloudRunServiceId(id), resources: run.snapshot.resources,
    });
    await h.service.inspectRun(id);
    await h.cleanup.cleanupAutomationRun(id);
    id = h.data.get("workspaceTickets/one").runId;
  }
  const ticket = h.data.get("workspaceTickets/one");
  assert.equal(ticket.status, "failed");
  assert.equal(ticket.errorCode, "automation_provisioning_oom");
  assert.equal(h.data.get(`automationRuns/${id}`).oomRetryCount, 2);
  assert.deepEqual(h.data.get(`automationRuns/${id}`).snapshot.resources, {cpu: "2", memory: "8Gi"});
  assert.equal([...h.data.keys()].filter((key) => key.startsWith("automationRuns/")).length, 3);
});

test("cancellation during deletion wins over startup OOM recovery", async () => {
  const h = harness({duringDeletion: async (data) => {
    const key = "automationRuns/ticket-one";
    data.set(key, {...data.get(key), desiredOutcome: "canceled"});
  }});
  await h.service.inspectRun(h.run.runId);
  await h.cleanup.cleanupAutomationRun(h.run.runId);
  assert.equal(h.data.get("workspaceTickets/one").status, "canceled");
  assert.equal(h.data.get("workspaceTickets/one").errorCode, null);
  assert.equal(h.data.get("automationRuns/ticket-one").oomRetryRunId, undefined);
});

for (const overrides of [
  {run: {desiredOutcome: "canceled"}},
  {run: {oomRetryCount: 2}},
  {session: {resources: {cpu: "8", memory: "32Gi"}}},
  {ticket: {status: "canceled"}},
  {workspace: {deleted: true}},
  {serviceAbsent: false},
]) {
  test(`no automatic replay for ${JSON.stringify(overrides)}`, async () => {
    const h = harness(overrides);
    await h.service.inspectRun(h.run.runId);
    await h.cleanup.cleanupAutomationRun(h.run.runId);
    assert.equal([...h.data.keys()].filter((key) => key.startsWith("automationRuns/")).length, 1);
  });
}

test("lookup failure retains recoverable cleanup rather than publishing an ambiguous result", async () => {
  const h = harness({run: {status: "failed"}, readOomEvidence: async () => {throw new Error("unavailable");}});
  await h.cleanup.cleanupAutomationRun(h.run.runId);
  assert.equal(h.data.get("automationRuns/ticket-one").cleanupState, "error");
  assert.deepEqual(h.calls, []);
});

test("a timeout without platform OOM evidence never creates a retry", async () => {
  const h = harness({run: {status: "interrupted", executionErrorCode: "control_timeout"},
    readOomEvidence: async () => null});
  await h.cleanup.cleanupAutomationRun(h.run.runId);
  assert.equal(h.data.get("workspaceTickets/one").errorCode, "control_timeout");
  assert.equal(h.data.get("automationRuns/ticket-one").oomRetryRunId, undefined);
});

test("memory grows within the catalog and CPU increases only when required", () => {
  assert.deepEqual(nextResources({cpu: "1", memory: "2Gi"}), {cpu: "1", memory: "4Gi"});
  assert.deepEqual(nextResources({cpu: "1", memory: "4Gi"}), {cpu: "2", memory: "8Gi"});
  assert.deepEqual(nextResources({cpu: "4", memory: "4Gi"}), {cpu: "4", memory: "8Gi"});
  assert.deepEqual(nextResources({cpu: "4", memory: "16Gi"}), {cpu: "6", memory: "24Gi"});
  assert.deepEqual(nextResources({cpu: "6", memory: "24Gi"}), {cpu: "8", memory: "32Gi"});
  assert.equal(nextResources({cpu: "8", memory: "32Gi"}), null);
  assert.equal(nextResources(null), null);
});

test("OOM detection accepts only platform logs for this service since this attempt", async () => {
  const serviceId = automationCloudRunServiceId("ticket-one");
  const good = {timestamp, logName: "projects/test/logs/run.googleapis.com%2Fvarlog%2Fsystem",
    resource: {labels: {service_name: serviceId, revision_name: "rev"}},
    textPayload: "Memory limit of 2048 MiB exceeded with 2050 MiB used."};
  let entries = [good];
  let request;
  const deps = {projectId: "test", auth: {getClient: async () => ({request: async (value) => {
    request = value; return {data: {entries}};
  }})}};
  const run = {runId: "ticket-one", createdAt: timestamp};
  assert.deepEqual(await readOomEvidence(run, {serviceId}, deps), {timestamp, revision: "rev"});
  assert.match(request.data.filter, /varlog\/system/);
  for (const invalid of [
    {...good, logName: "projects/test/logs/run.googleapis.com%2Fstderr"},
    {...good, timestamp: "2026-10-21T20:00:00.000Z"},
    {...good, textPayload: "Container called exit(137)."},
    {...good, resource: {labels: {service_name: "other"}}},
  ]) {
    entries = [invalid];
    assert.equal(await readOomEvidence(run, {serviceId}, deps), null);
  }
});
