"use strict";

const assert = require("node:assert/strict");
const {createSyncWriterLeaseService} = require("./syncWriterLease.service");

function createFakeFirestore(workspace, sessions) {
  const workspaceRef = {
    id: "workspace-1",
    collection(name) {
      assert.strictEqual(name, "sessions");
      return sessionsRef;
    },
  };
  const sessionsRef = {id: "sessions"};
  const sessionRefs = new Map();
  for (const id of Object.keys(sessions)) {
    sessionRefs.set(id, {id});
  }
  const refData = (ref) => {
    if (ref === workspaceRef) return workspace;
    if (ref === sessionsRef) {
      return Object.entries(sessions).map(([id, session]) => ({
        id,
        ref: sessionRefs.get(id),
        exists: true,
        data: () => session,
      }));
    }
    const session = sessions[ref.id];
    return session ? {exists: true, data: () => session} : {exists: false, data: () => ({})};
  };

  return {
    collection(name) {
      assert.strictEqual(name, "workspaces");
      return {doc: (id) => {
        assert.strictEqual(id, "workspace-1");
        return workspaceRef;
      }};
    },
    runTransaction: async (callback) => callback({
      get: async (ref) => {
        const data = refData(ref);
        if (Array.isArray(data)) return {docs: data};
        return {exists: data !== undefined, data: () => data};
      },
      update: (ref, updates) => {
        const target = ref === workspaceRef ? workspace : sessions[ref.id];
        Object.assign(target, updates);
      },
    }),
  };
}

(async () => {
  const workspace = {
    syncWriterSessionId: "writer",
    syncWriterLeaseId: "lease-1",
  };
  const sessions = {
    writer: {status: "running", sessionType: "cloud", syncWriterRole: "writer"},
    reader: {status: "running", sessionType: "cloud", syncWriterRole: "reader"},
  };
  const service = createSyncWriterLeaseService({db: createFakeFirestore(workspace, sessions)});
  const released = await service.releaseWorkspaceSyncWriterLease(
      {id: "writer"},
      {id: "writer", workspaceId: "workspace-1"},
      "manual",
  );
  assert.strictEqual(released, true);
  assert.strictEqual(workspace.syncWriterSessionId, "reader");
  assert.strictEqual(sessions.writer.syncWriterRole, "none");
  assert.strictEqual(sessions.reader.syncWriterRole, "writer");
  delete sessions.writer;
  assert.strictEqual(await service.releaseWorkspaceSyncWriterLease(
      {id: "writer"},
      {id: "writer", workspaceId: "workspace-1"},
      "duplicate",
  ), false);

  const staleWorkspace = {syncWriterSessionId: "missing", syncWriterLeaseId: "old-lease"};
  const staleSessions = {
    replacement: {status: "provisioning", sessionType: "cloud", syncWriterRole: "reader"},
  };
  const staleResult = await createSyncWriterLeaseService({
    db: createFakeFirestore(staleWorkspace, staleSessions),
  }).reconcileWorkspaceSyncWriterLease("workspace-1");
  assert.deepStrictEqual(staleResult, {status: "reassigned", sessionId: "replacement"});
  assert.strictEqual(staleWorkspace.syncWriterSessionId, "replacement");
  assert.strictEqual(staleSessions.replacement.syncWriterRole, "writer");

  const clearWorkspace = {syncWriterSessionId: "stale", syncWriterLeaseId: "old-lease"};
  const clearResult = await createSyncWriterLeaseService({
    db: createFakeFirestore(clearWorkspace, {stale: {status: "stopped", sessionType: "cloud"}}),
  }).reconcileWorkspaceSyncWriterLease("workspace-1");
  assert.deepStrictEqual(clearResult, {status: "cleared"});
  assert.strictEqual(clearWorkspace.syncWriterSessionId, null);
  assert.strictEqual(clearWorkspace.syncWriterLeaseId, null);

  console.log("sync writer lease service tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
