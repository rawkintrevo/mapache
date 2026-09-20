"use strict";

const assert = require("node:assert/strict");
const {
  assertAutomationStateTransition,
  canReleaseAutomationConcurrency,
  isAutomationSession,
  isMainSession,
  isTerminalAutomationStatus,
  isValidAutomationStateTransition,
  shouldKeepAutomationReservation,
  transitionAutomationRun,
} = require("./automationState.helpers");

assert.equal(isValidAutomationStateTransition("queued", "provisioning"), true);
assert.equal(isValidAutomationStateTransition("running", "succeeded"), true);
assert.equal(isValidAutomationStateTransition("succeeded", "running"), false);
assert.equal(isValidAutomationStateTransition("queued", "running"), false);
assert.doesNotThrow(() => assertAutomationStateTransition("provisioning", "failed"));
assert.throws(() => assertAutomationStateTransition("failed", "running"), /invalid_automation_state_transition/);
assert.deepEqual(transitionAutomationRun({status: "queued", runId: "run-1"}, "provisioning", {sessionId: "auto-run-1"}), {
  status: "provisioning",
  runId: "run-1",
  sessionId: "auto-run-1",
});
assert.equal(isTerminalAutomationStatus("skipped"), true);
assert.equal(canReleaseAutomationConcurrency({status: "succeeded", cleanupState: "complete"}), true);
assert.equal(canReleaseAutomationConcurrency({status: "succeeded", cleanupState: "pending"}), false);
assert.equal(shouldKeepAutomationReservation({status: "stopping", cleanupState: "complete"}), true);
assert.equal(shouldKeepAutomationReservation({status: "failed", cleanupState: "complete"}), false);
assert.equal(isAutomationSession({runtimeKind: "automation"}), true);
assert.equal(isAutomationSession({}), false);
assert.equal(isMainSession({}), true);

console.log("automation state helper tests passed");
