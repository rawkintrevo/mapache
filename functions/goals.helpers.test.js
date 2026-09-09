"use strict";

const assert = require("node:assert/strict");
const {
  assertGoalTransition,
  canTransitionGoal,
  normalizeGoalAction,
  normalizeGoalPayload,
} = require("./goals.helpers");

assert.deepEqual(normalizeGoalPayload({objective: "  Ship feature  ", mode: "sisyphus"}), {
  title: "Ship feature",
  objective: "Ship feature",
  mode: "sisyphus",
  auditEnabled: true,
});
assert.deepEqual(normalizeGoalAction({action: "pause", expectedRevision: 2, operationId: "op-1"}), {
  action: "pause", expectedRevision: 2, operationId: "op-1",
});
assert.equal(canTransitionGoal("draft", "open"), true);
assert.equal(canTransitionGoal("draft", "ready"), true);
assert.throws(() => assertGoalTransition("completed", "open"), (error) => error.publicMessage === "invalid_goal_transition");
assert.throws(() => normalizeGoalPayload({objective: ""}), (error) => error.publicMessage === "invalid_goal_objective");
console.log("goals helper tests passed");
