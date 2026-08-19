"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  canTransitionSession,
  isSessionFailure,
  isSessionTerminal,
  sessionStatusUpdate,
} = require("./sessionLifecycle.helpers");

test("accepts normal create, resize, restart, stop, delete, and failure transitions", () => {
  assert.equal(canTransitionSession("provisioning", "running"), true);
  assert.equal(canTransitionSession("running", "resizing"), true);
  assert.equal(canTransitionSession("running", "restarting"), true);
  assert.equal(canTransitionSession("stopping", "stopped"), true);
  assert.equal(canTransitionSession("deleting", "delete_failed"), true);
  assert.equal(canTransitionSession("running", "stopped"), false);
});

test("allows explicit reconciliation and rejects unknown states", () => {
  assert.equal(canTransitionSession("legacy_state", "running"), false);
  assert.equal(canTransitionSession("legacy_state", "running", {reconciliationReason: "repair"}), true);
  assert.throws(() => sessionStatusUpdate({status: "running"}, "stopped"), /invalid_session_transition/);
  assert.deepEqual(sessionStatusUpdate({status: "running"}, "stopping", {stopReason: "manual"}), {
    stopReason: "manual",
    status: "stopping",
  });
});

test("classifies terminal and failure states", () => {
  assert.equal(isSessionTerminal("stopped"), true);
  assert.equal(isSessionTerminal("provision_failed"), false);
  assert.equal(isSessionFailure("provision_failed"), true);
  assert.equal(isSessionFailure("running"), false);
});
