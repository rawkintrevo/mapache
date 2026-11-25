"use strict";

const VM_RUNTIME_COLLECTION = "vmRuntimes_v2";
const VM_CREDENTIALS_COLLECTION = "vmRuntimeCredentials_v2";
const COMPUTE_ENGINE_BACKEND = "compute-engine";

async function readAutomationAgentContext({db, sessionCollection, workspaceId, sessionId} = {}) {
  const vmWorkspaceRef = db.collection(VM_RUNTIME_COLLECTION).doc(workspaceId);
  const legacyWorkspaceRef = db.collection("workspaces").doc(workspaceId);
  const legacySessionRef = sessionCollection(workspaceId).doc(sessionId);
  const [vmWorkspaceSnapshot, legacyWorkspaceSnapshot, legacySessionSnapshot] = await Promise.all([
    vmWorkspaceRef.get(),
    legacyWorkspaceRef.get(),
    legacySessionRef.get(),
  ]);

  if (vmWorkspaceSnapshot.exists && vmWorkspaceSnapshot.data()?.backend === COMPUTE_ENGINE_BACKEND) {
    const vmSessionSnapshot = await vmWorkspaceRef.collection("sessions").doc(sessionId).get();
    const credentialsSnapshot = await db.collection(VM_CREDENTIALS_COLLECTION).doc(sessionId).get();
    const runtime = vmWorkspaceSnapshot.data() || {};
    const vmSession = vmSessionSnapshot.exists ? vmSessionSnapshot.data() || {} : null;
    const credentials = credentialsSnapshot.exists ? credentialsSnapshot.data() || {} : null;
    if (!vmSession || !credentials || credentials.ownerUid !== runtime.ownerUid ||
        credentials.generation !== runtime.generation || vmSession.ownerUid !== runtime.ownerUid ||
        vmSession.generation !== runtime.generation) {
      return {session: null, workspace: null};
    }
    return {
      session: {...vmSession, id: sessionId, workspaceId, shutdownToken: credentials.shutdownToken},
      workspace: {...runtime, id: workspaceId},
    };
  }

  return {
    session: legacySessionSnapshot.exists ? {...(legacySessionSnapshot.data() || {}), id: sessionId} : null,
    workspace: legacyWorkspaceSnapshot.exists ? {...(legacyWorkspaceSnapshot.data() || {}), id: workspaceId} : null,
  };
}

// Automation authority belongs to its session; main authority must also match
// the workspace so a replaced main cannot keep using an unexpired API token.
function hasAutomationAgentAuthority(session, workspace, sessionId) {
  if (workspace.backend === COMPUTE_ENGINE_BACKEND || session.runtimeProvider?.backend === COMPUTE_ENGINE_BACKEND) {
    return workspace.backend === COMPUTE_ENGINE_BACKEND && session.runtimeProvider?.backend === COMPUTE_ENGINE_BACKEND &&
      workspace.currentSessionId === sessionId && workspace.apiEnabled === true && workspace.lifecycleEnabled === true &&
      workspace.state === "active" && workspace.generation === session.generation &&
      session.runtimeProvider.generation === session.generation && workspace.bootId === session.bootId &&
      session.state === "active" && Number(session.leaseExpiresAt) > Date.now() &&
      Number(workspace.leaseExpiresAt) > Date.now();
  }
  if (session.runtimeKind === "automation") return session.agentRuntimeSessionId === sessionId;
  if (session.runtimeKind && session.runtimeKind !== "main") return false;
  return session.runnerSessionId === sessionId &&
    workspace.agentRuntimeAuthorityState === "admitted" &&
    workspace.agentRuntimeSessionId === sessionId &&
    String(workspace.agentRuntimeGeneration || "") === String(session.agentRuntimeGeneration || "") &&
    workspace.agentRuntimeBootInstanceId === session.agentRuntimeBootInstanceId;
}

function sessionGeneration(session = {}) {
  return session.agentRuntimeGeneration || session.generation || "";
}

function sessionBootInstanceId(session = {}) {
  return session.agentRuntimeBootInstanceId || session.bootInstanceId || session.bootId || "";
}

function isLiveAutomationSession(session = {}) {
  const state = String(session.status || session.state || "").trim().toLowerCase();
  return state === "running" || state === "ready" ||
    (state === "active" && Number(session.leaseExpiresAt) > Date.now());
}

module.exports = {
  hasAutomationAgentAuthority,
  isLiveAutomationSession,
  readAutomationAgentContext,
  sessionBootInstanceId,
  sessionGeneration,
};
