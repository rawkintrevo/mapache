"use strict";

const {AGENT_UI_VERSION} = require("./agentRuntime.helpers");
const {isAutomationRuntime} = require("./runtimePaths.helpers");

const ACTIVE_RUNTIME_SESSION_STATUSES = new Set([
  "provisioning", "running", "restarting", "resizing", "stopping", "deleting",
]);
const ACTIVE_RUNTIME_WORKSPACE_STATES = new Set(["starting", "running", "stopping"]);

function isMarkedRuntimeWorkspace(workspace = {}) {
  return workspace.agentUiVersion === AGENT_UI_VERSION;
}

function isMarkedRuntimeSession(session = {}) {
  return session.agentUiVersion === AGENT_UI_VERSION;
}

function isActiveMarkedRuntimeSession(session = {}) {
  return isMarkedRuntimeSession(session) && ACTIVE_RUNTIME_SESSION_STATUSES.has(
      String(session.status || "").trim().toLowerCase(),
  );
}

function positiveRuntimeGeneration(value) {
  const generation = Number(value);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
}

function nextRuntimeGeneration(workspace = {}, sessions = []) {
  const generations = [positiveRuntimeGeneration(workspace.agentRuntimeGeneration)];
  sessions.forEach((session) => generations.push(positiveRuntimeGeneration(session.agentRuntimeGeneration)));
  return Math.max(...generations) + 1;
}

function resolveRuntimeReservation(workspace = {}, sessions = [], session = {}, sessionId, operationId, options = {}) {
  if (!options.enabled || !isMarkedRuntimeWorkspace(workspace) || !isMarkedRuntimeSession(session)) {
    return {idempotent: false, conflict: null, sessionUpdates: {}, workspaceUpdates: {}};
  }

  const current = sessions.find((candidate) => candidate.id === sessionId) || null;
  if (current && options.idempotent !== false) {
    return {idempotent: true, conflict: null, sessionUpdates: {}, workspaceUpdates: {}};
  }

  if (isAutomationRuntime(session)) {
    const generation = nextRuntimeGeneration(workspace, sessions);
    const normalizedOperationId = String(operationId || "").trim();
    return {
      idempotent: false,
      conflict: null,
      sessionUpdates: {
        agentRuntimeOperationId: normalizedOperationId,
        agentRuntimeSessionId: sessionId,
        agentRuntimeGeneration: generation,
        agentRuntimeState: "starting",
        agentRuntimeAuthorityState: "starting",
      },
      workspaceUpdates: {},
    };
  }

  const reservedSessionId = String(workspace.agentRuntimeSessionId || "").trim();
  const workspaceBusy = reservedSessionId && reservedSessionId !== sessionId &&
    ACTIVE_RUNTIME_WORKSPACE_STATES.has(String(workspace.agentRuntimeState || "").trim().toLowerCase());
  const activeSession = sessions.find((candidate) => candidate.id !== sessionId && isActiveMarkedRuntimeSession(candidate));
  if (workspaceBusy || activeSession) {
    return {
      idempotent: false,
      conflict: activeSession ? activeSession.id : reservedSessionId,
      sessionUpdates: {},
      workspaceUpdates: {},
    };
  }

  const generation = nextRuntimeGeneration(workspace, sessions);
  const normalizedOperationId = String(operationId || "").trim();
  return {
    idempotent: false,
    conflict: null,
    sessionUpdates: {
      agentRuntimeOperationId: normalizedOperationId,
      agentRuntimeGeneration: generation,
      agentRuntimeState: "starting",
    },
    workspaceUpdates: {
      agentRuntimeSessionId: sessionId,
      agentRuntimeOperationId: normalizedOperationId,
      agentRuntimeGeneration: generation,
      agentRuntimeState: "starting",
      agentRuntimeUpdatedAt: options.now || null,
    },
  };
}

function runtimeStateUpdate(workspace = {}, session = {}, state, now, options = {}) {
  if (!isMarkedRuntimeWorkspace(workspace) || !isMarkedRuntimeSession(session)) return {};
  if (isAutomationRuntime(session)) return {};
  const sessionId = String(session.id || "").trim();
  const reservedSessionId = String(workspace.agentRuntimeSessionId || "").trim();
  const sessionGeneration = positiveRuntimeGeneration(session.agentRuntimeGeneration);
  const workspaceGeneration = positiveRuntimeGeneration(workspace.agentRuntimeGeneration);
  if (!sessionId || reservedSessionId !== sessionId || !sessionGeneration || sessionGeneration !== workspaceGeneration) {
    return {};
  }
  const workspaceBootInstanceId = String(workspace.agentRuntimeBootInstanceId || "").trim();
  const sessionBootInstanceId = String(session.agentRuntimeBootInstanceId || "").trim();
  if (options.release && workspaceBootInstanceId && workspaceBootInstanceId !== sessionBootInstanceId) return {};
  return {
    agentRuntimeSessionId: options.release ? null : sessionId,
    agentRuntimeState: String(state || "").trim().toLowerCase(),
    agentRuntimeUpdatedAt: now || null,
    ...(options.release && workspaceBootInstanceId ? {
      agentRuntimeAuthorityState: "released",
      agentRuntimeBootHeartbeatAt: now || null,
      agentRuntimeBootInstanceId: null,
    } : {}),
  };
}

function runtimeSessionStateUpdate(session = {}, state) {
  return isMarkedRuntimeSession(session) ? {agentRuntimeState: String(state || "").trim().toLowerCase()} : {};
}

function runtimeSessionAuthorityStateUpdate(session = {}, state, now, options = {}) {
  if (!isMarkedRuntimeSession(session) || !isAutomationRuntime(session)) return {};
  const sessionId = String(session.id || "").trim();
  if (!sessionId) return {};
  return {
    agentRuntimeSessionId: options.release ? null : sessionId,
    agentRuntimeState: String(state || "").trim().toLowerCase(),
    agentRuntimeUpdatedAt: now || null,
    ...(options.release ? {
      agentRuntimeAuthorityState: "released",
      agentRuntimeBootHeartbeatAt: now || null,
      agentRuntimeBootInstanceId: null,
    } : {}),
  };
}

function runtimeAuthorityReleaseUpdates(workspace = {}, session = {}, now) {
  if (!isMarkedRuntimeWorkspace(workspace) || !isMarkedRuntimeSession(session)) {
    return {sessionUpdates: {}, workspaceUpdates: {}};
  }
  if (isAutomationRuntime(session)) {
    return {
      sessionUpdates: runtimeSessionAuthorityStateUpdate(session, "stopped", now, {release: true}),
      workspaceUpdates: {},
    };
  }
  const bootInstanceId = String(session.agentRuntimeBootInstanceId || "").trim();
  const sessionId = String(session.id || "").trim();
  const generation = positiveRuntimeGeneration(session.agentRuntimeGeneration);
  if (!bootInstanceId || !sessionId ||
    String(workspace.agentRuntimeSessionId || "").trim() !== sessionId ||
    String(workspace.agentRuntimeBootInstanceId || "").trim() !== bootInstanceId ||
    positiveRuntimeGeneration(workspace.agentRuntimeGeneration) !== generation) {
    return {sessionUpdates: {}, workspaceUpdates: {}};
  }
  return {
    sessionUpdates: {
      agentRuntimeAuthorityState: "released",
      agentRuntimeBootHeartbeatAt: now || null,
      agentRuntimeBootInstanceId: null,
    },
    workspaceUpdates: {
      agentRuntimeAuthorityState: "released",
      agentRuntimeBootHeartbeatAt: now || null,
      agentRuntimeBootInstanceId: null,
    },
  };
}

function runtimeAuthoritySessionReleaseUpdates(session = {}, now) {
  if (!isMarkedRuntimeSession(session) || !String(session.agentRuntimeBootInstanceId || "").trim()) return {};
  return {
    agentRuntimeAuthorityState: "released",
    agentRuntimeBootHeartbeatAt: now || null,
    agentRuntimeBootInstanceId: null,
  };
}

module.exports = {
  ACTIVE_RUNTIME_SESSION_STATUSES,
  ACTIVE_RUNTIME_WORKSPACE_STATES,
  isActiveMarkedRuntimeSession,
  isMarkedRuntimeSession,
  isMarkedRuntimeWorkspace,
  nextRuntimeGeneration,
  positiveRuntimeGeneration,
  resolveRuntimeReservation,
  runtimeAuthorityReleaseUpdates,
  runtimeAuthoritySessionReleaseUpdates,
  runtimeSessionAuthorityStateUpdate,
  runtimeSessionStateUpdate,
  runtimeStateUpdate,
};
