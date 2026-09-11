"use strict";

const AGENT_AUDIENCE = "agent";
const AGENT_IMAGE_KEY = "pi-chrome";
const AGENT_UI_VERSION = "pi-web-ui-v1";

function isMarkedAgentWorkspace(workspace = {}) {
  return workspace.agentUiVersion === AGENT_UI_VERSION;
}

function explicitRuntimeGeneration(value) {
  const generation = String(value ?? "").trim();
  return generation && generation !== "0" ? generation : "";
}

function isCompatibleAgentSession(workspace = {}, session = {}) {
  return isMarkedAgentWorkspace(workspace) &&
    session.agentUiVersion === AGENT_UI_VERSION &&
    explicitRuntimeGeneration(session.agentRuntimeGeneration) !== "" &&
    session.status === "running" &&
    Boolean(String(session.serviceUrl || "").trim()) &&
    session.harnessId === "pi" &&
    session.imageKey === AGENT_IMAGE_KEY &&
    session.capabilities?.chrome === true;
}

function markedAgentSessionMetadata(workspace = {}) {
  return isMarkedAgentWorkspace(workspace) ? {agentUiVersion: AGENT_UI_VERSION} : {};
}

function agentRuntimeEnvironment(session = {}) {
  return [
    {name: "MAPACHE_AGENT_UI_VERSION", value: session.agentUiVersion === AGENT_UI_VERSION ? AGENT_UI_VERSION : ""},
    {name: "MAPACHE_AGENT_RUNTIME_GENERATION", value: explicitRuntimeGeneration(session.agentRuntimeGeneration)},
  ];
}

module.exports = {
  AGENT_AUDIENCE,
  AGENT_IMAGE_KEY,
  AGENT_UI_VERSION,
  agentRuntimeEnvironment,
  explicitRuntimeGeneration,
  isCompatibleAgentSession,
  isMarkedAgentWorkspace,
  markedAgentSessionMetadata,
};
