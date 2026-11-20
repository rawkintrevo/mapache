"use strict";

const AGENT_AUDIENCE = "agent";
const AGENT_IMAGE_KEY = "gcp-runner";
const LEGACY_AGENT_IMAGE_KEYS = Object.freeze(["pi-chrome"]);
const AGENT_IMAGE_KEYS = Object.freeze([AGENT_IMAGE_KEY, ...LEGACY_AGENT_IMAGE_KEYS]);
const AGENT_UI_VERSION = "pi-web-ui-v1";

function isAgentImageKey(value) {
  return AGENT_IMAGE_KEYS.includes(String(value || "").trim().toLowerCase());
}

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
    isAgentImageKey(session.imageKey) &&
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
  AGENT_IMAGE_KEYS,
  AGENT_UI_VERSION,
  isAgentImageKey,
  LEGACY_AGENT_IMAGE_KEYS,
  agentRuntimeEnvironment,
  explicitRuntimeGeneration,
  isCompatibleAgentSession,
  isMarkedAgentWorkspace,
  markedAgentSessionMetadata,
};
