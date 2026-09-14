"use strict";

const assert = require("node:assert/strict");
const {
  AGENT_IMAGE_KEY,
  AGENT_UI_VERSION,
  agentRuntimeEnvironment,
  explicitRuntimeGeneration,
  isCompatibleAgentSession,
  isMarkedAgentWorkspace,
  markedAgentSessionMetadata,
} = require("./agentRuntime.helpers");

const workspace = {agentUiVersion: AGENT_UI_VERSION};
const session = {
  agentRuntimeGeneration: "7",
  agentUiVersion: AGENT_UI_VERSION,
  capabilities: {chrome: true},
  harnessId: "pi",
  imageKey: AGENT_IMAGE_KEY,
  serviceUrl: "https://runner.example",
  status: "running",
};

assert.equal(isMarkedAgentWorkspace(workspace), true);
assert.deepEqual(markedAgentSessionMetadata(workspace), {agentUiVersion: AGENT_UI_VERSION});
assert.equal(isCompatibleAgentSession(workspace, session), true);
assert.equal(isCompatibleAgentSession(workspace, {...session, agentRuntimeGeneration: "0"}), false);
assert.equal(isCompatibleAgentSession(workspace, {...session, imageKey: "pi-web"}), false);
assert.equal(isCompatibleAgentSession({}, session), false);
assert.equal(explicitRuntimeGeneration(7), "7");
assert.equal(explicitRuntimeGeneration(0), "");
assert.deepEqual(agentRuntimeEnvironment(session), [
  {name: "MAPACHE_AGENT_UI_VERSION", value: AGENT_UI_VERSION},
  {name: "MAPACHE_AGENT_RUNTIME_GENERATION", value: "7"},
]);
assert.deepEqual(agentRuntimeEnvironment({}), [
  {name: "MAPACHE_AGENT_UI_VERSION", value: ""},
  {name: "MAPACHE_AGENT_RUNTIME_GENERATION", value: ""},
]);

console.log("agent runtime helper tests passed");
