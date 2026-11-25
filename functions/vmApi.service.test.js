"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {createVmApiService, ACCESS_TTL_MS} = require("./vmApi.service");
const {createBrowserAccessVerifier} = require("../session-runner/lib/browserAccess");

function fixture() {
  const time = 100000;
  const ws = {ownerUid: "owner", backend: "compute-engine", apiEnabled: true, lifecycleReadyGeneration: 7,
    generation: 7, state: "active", currentSessionId: "session", bootId: "boot", leaseExpiresAt: time + 45000,
    gatewayHost: "fixture.example.com", privateField: "not-for-clients"};
  const session = {ownerUid: "owner", generation: 7, state: "active", bootId: "boot", leaseExpiresAt: time + 45000};
  const credentials = {ownerUid: "owner", generation: 7, browserToken: "b".repeat(64), controlToken: "control-secret", shutdownToken: "shutdown-secret"};
  const route = {ownerUid: "owner", workspaceId: "workspace", generation: 7, sessionId: "session", enabled: true, address: "10.90.0.12"};
  const docs = new Map([["vmRuntimes_v2/workspace", ws], ["vmRuntimes_v2/workspace/sessions/session", session],
    ["vmRuntimeCredentials_v2/session", credentials], ["vmGatewayRoutes_v2/fixture.example.com", route]]);
  const ref = path => ({path, doc: id => ref(`${path}/${id}`), collection: id => ref(`${path}/${id}`),
    get: async () => ({exists: docs.has(path), data: () => docs.get(path)}),
    where: (field, operator, value) => ({limit: () => ({get: async () => ({docs: [...docs.entries()]
      .filter(([key, data]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/") &&
        (operator !== "==" || data[field] === value)).map(([key, data]) => ({id: key.slice(path.length + 1), data: () => data}))})})}),
    limit: () => ({get: async () => ({docs: [...docs.entries()]
      .filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/"))
      .map(([key, data]) => ({id: key.slice(path.length + 1), data: () => data}))})})});
  const calls = [];
  const restoreCalls = [];
  const service = createVmApiService({now: () => time, db: {collection: ref, runTransaction: fn => fn({get: r => r.get(), update: (r, updates) => {
    const current = docs.get(r.path) || {};
    docs.set(r.path, {...current, ...updates});
  }})},
    requireUser: async req => {
      if (!req.authenticatedUid) throw new Error("invalid_auth_token");
      if (req.authenticatedUid === "not-allowed") throw new Error("app_access_not_allowed");
      return {uid: req.authenticatedUid};
    }, lifecycle: {request: async args => { calls.push(args); return {operationId: "operation", status: "pending"}; }},
    requestBackupRestore: async args => { restoreCalls.push(args); return {operationId: "restore-operation", status: "pending"}; }});
  return {ws, session, credentials, route, docs, calls, restoreCalls, time,
    call: (path = "/workspaces/workspace/access", body = {expectedGeneration: 7}, method = "POST", uid = "owner") =>
      service({path, body, method, authenticatedUid: uid})};
}

test("backup restore requests are owner-scoped, strict, and durable", async () => {
  const f = fixture();
  const result = await f.call("/workspaces/workspace/backup", {
    requestId: "restore-request", backupId: "backup-1", expectedGeneration: 7, targetSizeGb: 96,
  });
  assert.equal(result.status, 202);
  assert.deepEqual(f.restoreCalls[0], {workspaceId: "workspace", ownerUid: "owner", requestId: "restore-request",
    backupId: "backup-1", expectedGeneration: 7, targetDiskName: undefined, targetSizeGb: 96});
  await assert.rejects(f.call("/workspaces/workspace/backup", {requestId: "restore-request"}), /invalid_vm_backup_restore_request/);
  await assert.rejects(f.call("/workspaces/workspace/backup", {requestId: "restore-request", backupId: "backup-1", ownerUid: "foreign"}),
    /invalid_vm_backup_restore_request/);
});

test("backup status is owner-scoped and exposes bounded recovery diagnostics without secrets", async () => {
  const f = fixture();
  f.docs.set("vmBackupInventoryReports_v2/workspace", {
    ownerUid: "owner", observedAt: "2026-01-01T00:00:00.000Z",
    compute: {instancePresent: true, instanceStatus: "RUNNING", instanceRunning: true, diskPresent: true,
      diskStatus: "READY", diskAttached: true, diskSizeGb: 64, headroomKnown: false},
    backups: {observed: 2, providerObserved: 2, verified: 1, sourceDigestsVerified: 0, sourceDigestsMissing: 1,
      backupAgeMs: 1000, oldestPending: false,
      retentionCandidates: [{name: "snapshot-1", reason: "retention_expired"}], held: [], quarantined: []},
    strandedResources: {diskDetached: false, instanceWithoutDisk: false, diskWithoutInstance: false,
      ownedInstanceCount: 1, ownedDiskCount: 1, unexpectedOwnedInstances: [], unexpectedOwnedDisks: [], resourceInventoryKnown: true},
    cost: {retainedStorageMonthlyUsd: 6.4, snapshotStorageMonthlyUsd: 0.13, computeMonthlyUsd: null,
      totalKnownMonthlyUsd: 6.53, ratesAreEstimates: true, unknownComponents: ["compute", "network"]},
  });
  f.docs.set("vmBackupRecoveryOperations_v2/recovery-1", {ownerUid: "owner", workspaceId: "workspace",
    status: "pending", phase: "verify", attempts: 2, createdAtMs: 100, updatedAtMs: 200,
    lastError: "runner_not_ready", backupId: "backup-1", restoreReceipt: {targetDisk: "secret-disk"}});
  f.docs.set("vmBackupRecoveryReports_v2/workspace/reports/recovery-1", {ownerUid: "owner", workspaceId: "workspace",
    operationId: "recovery-1", verifiedAt: "2026-01-01T00:01:00.000Z", runtimeReady: false,
    startupStageTimingsMs: {boot: 20, secret: -1}, rpoMs: 10, rtoMs: 20, rpoTargetMs: 100, rtoTargetMs: 100,
    rpoWithinTarget: true, rtoWithinTarget: true, passed: false, failureCode: "runner_not_ready", fileDigest: "private"});
  const result = await f.call("/workspaces/workspace/backup", {}, "GET");
  assert.equal(result.status, 200);
  assert.equal(result.body.inventory.cost.totalKnownMonthlyUsd, 6.53);
  assert.equal(result.body.inventory.backups.sourceDigestsVerified, 0);
  assert.equal(result.body.inventory.backups.sourceDigestsMissing, 1);
  assert.equal(result.body.recovery.latestOperation.phase, "verify");
  assert.deepEqual(result.body.recovery.latestReport.startupStageTimingsMs, {boot: 20});
  assert.ok(!JSON.stringify(result.body).includes("secret-disk"));
  assert.ok(!JSON.stringify(result.body).includes("private"));
  f.ws.ownerUid = "foreign";
  await assert.rejects(f.call("/workspaces/workspace/backup", {}, "GET"), /not_found/);
});

test("Firebase identity and app admission precede every owner-scoped operation", async () => {
  const f = fixture();
  for (const uid of ["", "not-allowed", "foreign"]) await assert.rejects(f.call(undefined, undefined, undefined, uid));
  f.ws.apiEnabled = false;
  await assert.rejects(f.call(), /not_found/);
  await assert.rejects(f.call("/workspaces/workspace/pause", {expectedGeneration: 7, requestId: "pause"}), /not_found/);
  assert.equal(f.calls.length, 0);
});

test("access URLs are compatible with both real runner verifiers and never include stored credentials", async () => {
  const f = fixture(); const {status, body} = await f.call();
  assert.equal(status, 200);
  const tokens = [body.agentUrl, body.terminalUrl, body.previewUrl].map(url => new URL(url).searchParams.get("mapache_access"));
  assert.equal(new Set(tokens).size, 1);
  const base = {secret: f.credentials.browserToken, sessionId: "session", now: () => f.time};
  assert.equal(createBrowserAccessVerifier(base).verify(tokens[0]), true);
  assert.equal(createBrowserAccessVerifier({...base, audience: "agent", generation: 7, requireAudience: true, requireGeneration: true}).verify(tokens[0]), true);
  assert.equal(createBrowserAccessVerifier({...base, audience: "agent", generation: 6}).verify(tokens[0]), false);
  assert.equal(Date.parse(body.expiresAt) - f.time, ACCESS_TTL_MS);
  assert.equal(body.browserUrl, null);
  for (const secret of [f.credentials.browserToken, f.credentials.controlToken, f.credentials.shutdownToken, "10.90.0.12"]) assert.ok(!JSON.stringify(body).includes(secret));
});

test("stale generation, readiness, leases, ownership and route bindings cannot mint access", async () => {
  await assert.rejects(fixture().call(undefined, {expectedGeneration: 6}), /vm_generation_mismatch/);
  for (const change of [f => { f.ws.state = "stopping"; }, f => { f.ws.activeOperationId = "pause"; },
    f => { f.ws.lifecycleReadyGeneration = 6; }, f => { f.ws.leaseExpiresAt = 0; }, f => { f.session.bootId = "stale"; },
    f => { f.session.leaseExpiresAt = 0; }, f => { f.credentials.ownerUid = "foreign"; },
    f => { f.route.workspaceId = "foreign"; }, f => { f.route.generation = 6; }, f => { f.route.enabled = false; },
    f => { f.route.address = "169.254.169.254"; }]) {
    const f = fixture(); change(f); await assert.rejects(f.call());
  }
});

test("lifecycle dispatch derives owner from auth and forbids caller-selected runtime inputs", async () => {
  const f = fixture();
  const result = await f.call("/workspaces/workspace/replace", {expectedGeneration: 7, requestId: "request"});
  assert.equal(result.status, 202);
  assert.deepEqual(f.calls[0], {workspaceId: "workspace", ownerUid: "owner", action: "replace", expectedGeneration: 7, requestId: "request", requireApiAdmission: true,
    runtimeScheduleManualPause: false, runtimeScheduleManualStart: false});
  for (const extra of [{ownerUid: "foreign"}, {runnerImage: "attacker"}, {address: "169.254.169.254"}, {allowCreateDisk: true}]) {
    await assert.rejects(f.call("/workspaces/workspace/start", {expectedGeneration: 7, requestId: "request", ...extra}), /invalid_vm_request/);
  }
  assert.equal(f.calls.length, 1);
});

test("rename is owner-scoped and generation-fenced", async () => {
  const f = fixture();
  const result = await f.call("/workspaces/workspace/rename", {name: "  Renamed VM  ", expectedGeneration: 7}, "PATCH");
  assert.equal(result.status, 200);
  assert.equal(result.body.workspace.name, "Renamed VM");
  assert.equal(f.docs.get("vmRuntimes_v2/workspace").name, "Renamed VM");
  await assert.rejects(f.call("/workspaces/workspace/rename", {name: "Stale", expectedGeneration: 6}, "PATCH"), /vm_generation_mismatch/);
  await assert.rejects(f.call("/workspaces/workspace/rename", {name: "   ", expectedGeneration: 7}, "PATCH"), /invalid_workspace_name/);
  await assert.rejects(f.call("/workspaces/workspace/rename", {name: "Nope", expectedGeneration: 7}, "PATCH", "foreign"), /not_found/);
});

test("status exposes only safe fields and operation status cannot cross workspace ownership", async () => {
  const f = fixture();
  const result = await f.call("/workspaces/workspace", {}, "GET");
  assert.equal(result.body.workspace.ready, true);
  assert.ok(!JSON.stringify(result.body).includes("not-for-clients"));
  f.ws.leaseExpiresAt = 0;
  assert.equal((await f.call("/workspaces/workspace", {}, "GET")).body.workspace.ready, false);
  const id = "a".repeat(64);
  f.docs.set(`vmLifecycleOperations_v2/${id}`, {ownerUid: "owner", workspaceId: "foreign", descriptor: {generation: 7}});
  await assert.rejects(f.call(`/workspaces/workspace/operations/${id}`, {}, "GET"), /not_found/);
  f.docs.set(`vmLifecycleOperations_v2/${id}`, {ownerUid: "owner", workspaceId: "workspace", action: "replace",
    status: "pending", phase: "provision", descriptor: {generation: 7}, lastError: "disk_attach_failed",
    lastErrorAtMs: 1000, failedPhase: "provision", phaseStartedAtMs: 900,
    phaseTimingsMs: {quiesce: 25, provision: 80, secret: -1, oversized: 24 * 60 * 60 * 1000 + 1}});
  const status = await f.call(`/workspaces/workspace/operations/${id}`, {}, "GET");
  assert.deepEqual(status.body, {operationId: id, action: "replace", status: "pending", phase: "provision", generation: 7,
    lastError: "disk_attach_failed", lastErrorAtMs: 1000, failedPhase: "provision", phaseStartedAtMs: 900,
    phaseTimingsMs: {quiesce: 25, provision: 80}, nextAttemptAtMs: null, quiesceResult: null});
});
