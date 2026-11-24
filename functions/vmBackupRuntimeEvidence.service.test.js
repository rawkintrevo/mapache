"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createRuntimeDescriptor} = require("./runtimeProvider.helpers");
const {createVmBackupRuntimeEvidenceService} = require("./vmBackupRuntimeEvidence.service");

test("active admitted runner evidence captures bounded file and runtime digests", async () => {
  const db = memoryDb();
  const descriptor = createRuntimeDescriptor({backend: "compute-engine", workspaceId: "workspace-1", ownerUid: "owner-1", generation: 2});
  db.seed("vmRuntimes_v2/workspace-1", {ownerUid: "owner-1", generation: 2, state: "active", lifecycleEnabled: true,
    currentSessionId: "session-1", leaseExpiresAt: Date.now() + 60_000, gatewayHost: "gateway-abc-uc.a.run.app"});
  db.seed("vmRuntimeCredentials_v2/session-1", {ownerUid: "owner-1", shutdownToken: "shutdown-secret"});
  const requests = [];
  const service = createVmBackupRuntimeEvidenceService({db, now: () => 1_000, fetchImpl: async (url, options) => {
    requests.push({url, options});
    return {ok: true, json: async () => url.endsWith("/health") ? {
      ok: true, workspaceId: "workspace-1", sessionId: "session-1", agentRuntime: {ready: true, state: "ready"},
    } : {ok: true, workspaceId: "workspace-1", sessionId: "session-1", fileDigest: "sha256:" + "a".repeat(64), entryCount: 2, byteCount: 10}};
  }});
  const evidence = await service.capture({workspaceId: "workspace-1", ownerUid: "owner-1", descriptor});
  assert.equal(evidence.runtimeReady, true);
  assert.match(evidence.fileDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(evidence.runtimeStateDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(requests.map(request => new URL(request.url).pathname), ["/runner/health", "/runner/recovery-digest"]);
  assert.equal(requests[0].options.headers["x-shutdown-token"], "shutdown-secret");
});

test("stopped or lease-expired sources return no digest instead of inventing one", async () => {
  const db = memoryDb();
  const descriptor = createRuntimeDescriptor({backend: "compute-engine", workspaceId: "workspace-1", ownerUid: "owner-1", generation: 1});
  db.seed("vmRuntimes_v2/workspace-1", {ownerUid: "owner-1", generation: 1, state: "stopped", lifecycleEnabled: true});
  const service = createVmBackupRuntimeEvidenceService({db, fetchImpl: async () => { throw new Error("must_not_call"); }});
  assert.equal(await service.capture({workspaceId: "workspace-1", ownerUid: "owner-1", descriptor}), null);
});

function memoryDb() {
  const values = new Map();
  return {
    collection: name => ({doc: id => ({get: async () => {
      const value = values.get(`${name}/${id}`);
      return {exists: value !== undefined, data: () => value};
    }})}),
    seed(path, value) { values.set(path, value); },
  };
}
