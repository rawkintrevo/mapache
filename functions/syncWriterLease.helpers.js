"use strict";

const crypto = require("crypto");

const INACTIVE_STATUSES = new Set([
  "stopped", "needs_image", "provision_failed", "update_failed", "stop_failed",
  "delete_failed", "stopping", "deleting",
]);

function isSyncWriterEligible(session = {}, options = {}) {
  if (options.eligible === false) return false;
  if (session.sessionType === "ssh" || session.terminalKind === "ssh") return false;
  if (options.eligible === true) return true;
  return !INACTIVE_STATUSES.has(String(session.status || "").trim());
}

function isActiveSyncWriterSession(session = {}) {
  return isSyncWriterEligible(session) && Boolean(session.id);
}

function resolveSyncWriterLease(workspace = {}, sessions = [], session = {}, sessionId, options = {}) {
  const eligible = isSyncWriterEligible(session, options);
  const currentOwnerId = String(workspace.syncWriterSessionId || "").trim();
  const owner = sessions.find((candidate) => candidate.id === currentOwnerId);
  const ownerIsActive = currentOwnerId && (
    currentOwnerId === sessionId ||
    isActiveSyncWriterSession(owner)
  );

  if (!eligible) {
    return {
      sessionUpdates: {
        syncWriterRole: "none",
        syncWriterLeaseId: null,
        syncWriterLeaseUpdatedAt: null,
      },
      workspaceUpdates: ownerIsActive ? {} : clearWorkspaceSyncWriterLease(options.now),
    };
  }

  if (ownerIsActive && currentOwnerId !== sessionId) {
    return {
      sessionUpdates: {
        syncWriterRole: "reader",
        syncWriterLeaseId: null,
        syncWriterLeaseUpdatedAt: null,
      },
      workspaceUpdates: {},
    };
  }

  const leaseId = currentOwnerId === sessionId && workspace.syncWriterLeaseId ||
    (options.leaseId || crypto.randomUUID());
  return {
    sessionUpdates: {
      syncWriterRole: "writer",
      syncWriterLeaseId: leaseId,
      syncWriterLeaseUpdatedAt: options.now || null,
    },
    workspaceUpdates: {
      syncWriterSessionId: sessionId,
      syncWriterLeaseId: leaseId,
      syncWriterLeaseUpdatedAt: options.now || null,
    },
  };
}

function clearWorkspaceSyncWriterLease(now) {
  return {
    syncWriterSessionId: null,
    syncWriterLeaseId: null,
    syncWriterLeaseUpdatedAt: now || null,
  };
}

module.exports = {
  clearWorkspaceSyncWriterLease,
  isActiveSyncWriterSession,
  isSyncWriterEligible,
  resolveSyncWriterLease,
};
