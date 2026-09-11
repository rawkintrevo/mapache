"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createGoalsBridgeService,
  normalizeGoalsEnvelope,
  promptForCommand,
  readGoalFiles,
} = require("./goalsProtocol");

test("normalizes a goal command and maps it to the existing Pi prompt", () => {
  const command = normalizeGoalsEnvelope({
    protocolVersion: 1,
    type: "command",
    operationId: "op-1",
    goalId: "goal-1",
    action: "start",
    payload: {objective: "Add tests", mode: "sisyphus"},
  });
  assert.equal(promptForCommand(command), "/sisyphus-direct Add tests");
  assert.throws(() => promptForCommand({...command, payload: {objective: "unsafe\u001b[2J"}}), /invalid_goal_objective/);
});

test("rejects unsupported protocol and unbounded payloads", () => {
  assert.throws(() => normalizeGoalsEnvelope({type: "command", protocolVersion: 2}), /goal_protocol_unsupported/);
  assert.throws(() => normalizeGoalsEnvelope({
    type: "command", operationId: "op", goalId: "g", action: "pause", payload: {text: "x".repeat(70000)},
  }), /goal_payload_too_large/);
});

test("reads only bounded active goal files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-goals-"));
  const goals = path.join(root, ".pi", "goals");
  await fs.mkdir(goals, {recursive: true});
  await fs.writeFile(path.join(goals, "active_goal_a.md"), "# Goal A");
  await fs.writeFile(path.join(goals, "other.md"), "# hidden");
  const files = await readGoalFiles(fs, goals);
  assert.deepEqual(files.map((file) => file.path), [".pi/goals/active_goal_a.md"]);
});

test("bridge sends a typed start command through the existing terminal session", async () => {
  const prompts = [];
  const previous = process.env.GOAL_BRIDGE_ENABLED;
  process.env.GOAL_BRIDGE_ENABLED = "true";
  try {
    const bridge = createGoalsBridgeService({
      config: {harnessId: "pi", workspaceDir: "/workspace"},
      terminalSession: {writePrompt: (prompt) => prompts.push(prompt)},
    });
    const result = await bridge.command({
      protocolVersion: 1,
      type: "command",
      operationId: "op-1",
      goalId: "goal-1",
      action: "start",
      payload: {objective: "Ship it", mode: "regular"},
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(prompts, ["/goal-direct Ship it"]);
    assert.equal(bridge.operation("op-1").status, "accepted");
    bridge.setPackageAvailable(false);
    assert.equal(bridge.capabilities().reason, "managed_package_missing");
    await assert.rejects(() => bridge.command({
      protocolVersion: 1,
      type: "command",
      operationId: "op-2",
      goalId: "goal-1",
      action: "pause",
    }), /goal_bridge_unavailable/);
    bridge.setPackageAvailable(true);
    await assert.rejects(() => bridge.command({
      protocolVersion: 1,
      type: "answer",
      operationId: "op-answer",
      goalId: "goal-1",
      questionId: "question-1",
      requestId: "request-1",
      answer: "Use CSV",
    }), /goal_structured_dialogs_unavailable/);
  } finally {
    if (previous === undefined) delete process.env.GOAL_BRIDGE_ENABLED;
    else process.env.GOAL_BRIDGE_ENABLED = previous;
  }
});

test("disables the legacy Goals bridge on the managed pi-web-ui path", () => {
  const previous = process.env.GOAL_BRIDGE_ENABLED;
  process.env.GOAL_BRIDGE_ENABLED = "true";
  try {
    const bridge = createGoalsBridgeService({
      config: {agentRuntimeEnabled: true, harnessId: "pi", workspaceDir: "/workspace"},
      terminalSession: {writePrompt: () => { throw new Error("must not write to Pi"); }},
    });
    assert.equal(bridge.capabilities().enabled, false);
    assert.equal(bridge.capabilities().reason, "goal_bridge_disabled");
    return assert.rejects(() => bridge.command({
      protocolVersion: 1,
      type: "command",
      operationId: "managed-goal",
      goalId: "goal-1",
      action: "start",
      payload: {objective: "must not run"},
    }), /goal_bridge_unavailable/);
  } finally {
    if (previous === undefined) delete process.env.GOAL_BRIDGE_ENABLED;
    else process.env.GOAL_BRIDGE_ENABLED = previous;
  }
});
