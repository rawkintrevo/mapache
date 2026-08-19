"use strict";

const assert = require("node:assert/strict");
const {
  isActiveSyncWriterSession,
  isSyncWriterEligible,
  resolveSyncWriterLease,
} = require("./syncWriterLease.helpers");

const now = "timestamp";
const writer = {id: "session-writer", status: "running", sessionType: "cloud"};
const reader = {id: "session-reader", status: "provisioning", sessionType: "cloud"};

assert.strictEqual(isSyncWriterEligible(writer), true);
assert.strictEqual(isSyncWriterEligible({status: "running", sessionType: "ssh", terminalKind: "ssh"}), false);
assert.strictEqual(isActiveSyncWriterSession({id: "stopped", status: "stopped"}), false);

const firstLease = resolveSyncWriterLease({}, [], reader, reader.id, {now});
assert.strictEqual(firstLease.sessionUpdates.syncWriterRole, "writer");
assert.strictEqual(firstLease.workspaceUpdates.syncWriterSessionId, "session-reader");
assert.strictEqual(firstLease.workspaceUpdates.syncWriterLeaseUpdatedAt, now);

const concurrentLease = resolveSyncWriterLease({
  syncWriterSessionId: "session-reader",
  syncWriterLeaseId: "lease-1",
}, [reader], writer, writer.id, {now});
assert.deepStrictEqual(concurrentLease.sessionUpdates, {
  syncWriterRole: "reader",
  syncWriterLeaseId: null,
  syncWriterLeaseUpdatedAt: null,
});
assert.deepStrictEqual(concurrentLease.workspaceUpdates, {});

const staleLease = resolveSyncWriterLease({
  syncWriterSessionId: "deleted-session",
  syncWriterLeaseId: "lease-old",
}, [], writer, writer.id, {now});
assert.strictEqual(staleLease.sessionUpdates.syncWriterRole, "writer");
assert.strictEqual(staleLease.workspaceUpdates.syncWriterSessionId, writer.id);

const nonEligible = resolveSyncWriterLease({
  syncWriterSessionId: "deleted-session",
  syncWriterLeaseId: "lease-old",
}, [], {id: "ssh-1", status: "running", sessionType: "ssh", terminalKind: "ssh"}, "ssh-1", {now});
assert.strictEqual(nonEligible.sessionUpdates.syncWriterRole, "none");
assert.strictEqual(nonEligible.workspaceUpdates.syncWriterSessionId, null);

console.log("sync writer lease helper tests passed");
