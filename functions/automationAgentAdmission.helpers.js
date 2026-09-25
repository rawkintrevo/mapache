"use strict";

// Automation authority belongs to its session; main authority must also match
// the workspace so a replaced main cannot keep using an unexpired API token.
function hasAutomationAgentAuthority(session, workspace, sessionId) {
  if (session.runtimeKind === "automation") return session.agentRuntimeSessionId === sessionId;
  if (session.runtimeKind && session.runtimeKind !== "main") return false;
  return session.runnerSessionId === sessionId &&
    workspace.agentRuntimeAuthorityState === "admitted" &&
    workspace.agentRuntimeSessionId === sessionId &&
    String(workspace.agentRuntimeGeneration || "") === String(session.agentRuntimeGeneration || "") &&
    workspace.agentRuntimeBootInstanceId === session.agentRuntimeBootInstanceId;
}

module.exports = {hasAutomationAgentAuthority};
