"use strict";

const assert = require("node:assert/strict");
const {
  automationRunIdFromSessionId,
  automationRunPath,
  automationSessionId,
  isAutomationRuntime,
  isMainRuntime,
  normalizeRuntimeKind,
  workspaceAutomationPath,
  workspaceAutomationsPath,
} = require("./runtimePaths.helpers");

assert.equal(normalizeRuntimeKind(), "main");
assert.equal(normalizeRuntimeKind("automation"), "automation");
assert.equal(normalizeRuntimeKind("unknown"), "main");
assert.equal(isAutomationRuntime({runtimeKind: "automation"}), true);
assert.equal(isAutomationRuntime({}), false);
assert.equal(isMainRuntime({}), true);
assert.equal(automationSessionId("run-123"), "auto-run-123");
assert.equal(automationRunIdFromSessionId("auto-run-123"), "run-123");
assert.equal(automationRunIdFromSessionId("session-123"), "");
assert.equal(workspaceAutomationsPath("workspace-1"), "workspaces/workspace-1/automations");
assert.equal(workspaceAutomationPath("workspace-1", "automation-1"), "workspaces/workspace-1/automations/automation-1");
assert.equal(automationRunPath("run-1"), "automationRuns/run-1");
assert.throws(() => automationSessionId("run/1"), /invalid_automation_run_id/);

console.log("runtime path helper tests passed");
