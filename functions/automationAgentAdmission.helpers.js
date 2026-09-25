"use strict";

// Automation authority belongs to its session; main authority must also match
// the workspace so a replaced main cannot keep using an unexpired API token.
function hasAutomationAgentAuthority(session, workspace) {
  if (session.runtimeKind === "automation") return true;
  if (session.runtimeKind && session.runtimeKind !== "main") return false;
  return workspace.agentRuntimeAuthorityState === "admitted" &&
    workspace.agentRuntimeSessionId === session.agentRuntimeSessionId &&
    String(workspace.agentRuntimeGeneration || "") === String(session.agentRuntimeGeneration || "") &&
    workspace.agentRuntimeBootInstanceId === session.agentRuntimeBootInstanceId;
}

module.exports = {hasAutomationAgentAuthority};
