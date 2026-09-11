"use strict";

const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const {PassThrough, Writable} = require("node:stream");
const test = require("node:test");
const {createGoalsRpcService} = require("./goalsRpc.service");

function fakePiProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.writes = [];
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(String(chunk).trim());
      child.writes.push(message);
      if (message.type === "prompt") {
        child.stdout.write(`${JSON.stringify({type: "response", id: message.id, success: true})}\n`);
      }
      callback();
    },
  });
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    child.emit("exit", 0, null);
    return true;
  };
  return child;
}

test("uses Pi RPC and relays structured UI requests", async () => {
  const process = fakePiProcess();
  const rpc = createGoalsRpcService({
    config: {harnessId: "pi", workspaceDir: "/workspace", piSessionDir: "/workspace/.pi/session"},
    env: {GOAL_RPC_ENABLED: "true", HOME: "/root"},
    spawn: () => process,
    terminalSession: {isRunning: () => false},
  });

  assert.equal(rpc.supported, true);
  const result = await rpc.command({
    protocolVersion: 1,
    type: "command",
    operationId: "op-start",
    goalId: "goal-1",
    action: "start",
    payload: {objective: "Ship it", mode: "regular"},
  });
  assert.equal(result.transport, "pi-rpc");
  assert.equal(process.writes[0].message, "/goal Ship it");

  process.stdout.write(`${JSON.stringify({type: "extension_ui_request", id: "ui-1", method: "select", title: "Pick", options: ["A", "B"]})}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await rpc.snapshot()).pendingUiRequests[0].options, ["A", "B"]);
  await rpc.command({
    protocolVersion: 1,
    type: "answer",
    operationId: "op-answer",
    goalId: "goal-1",
    questionId: "ui-1",
    requestId: "ui-1",
    answer: "B",
    expectedRevision: 0,
  });
  assert.deepEqual(process.writes.at(-1), {type: "extension_ui_response", id: "ui-1", value: "B"});
  await rpc.stop();
});

test("rejects a managed goal command while the terminal Pi process is active", async () => {
  const rpc = createGoalsRpcService({
    config: {harnessId: "pi"},
    env: {GOAL_RPC_ENABLED: "true"},
    spawn: () => { throw new Error("spawn should not be called"); },
    terminalSession: {isRunning: () => true},
  });
  await assert.rejects(() => rpc.command({
    protocolVersion: 1,
    type: "command",
    operationId: "op-start",
    goalId: "goal-1",
    action: "start",
    payload: {objective: "Ship it"},
  }), /goal_terminal_process_active/);
});

test("does not create a second Pi process for the managed pi-web-ui runtime", () => {
  const rpc = createGoalsRpcService({
    config: {agentRuntimeEnabled: true, harnessId: "pi"},
    env: {GOAL_RPC_ENABLED: "true"},
    spawn: () => { throw new Error("spawn should not be called"); },
  });
  assert.equal(rpc.supported, false);
  assert.equal(rpc.capabilities().structuredDialogs, false);
});

test("hands off the terminal only after explicit consent and waits for its exit", async () => {
  const child = fakePiProcess();
  let release;
  let spawned = false;
  const rpc = createGoalsRpcService({
    config: {harnessId: "pi"}, env: {GOAL_RPC_ENABLED: "true"},
    terminalSession: {isRunning: () => true, releaseForGoal: () => new Promise((resolve) => { release = resolve; })},
    spawn: () => { spawned = true; return child; },
  });
  const command = {type: "command", operationId: "handoff", goalId: "goal-1", action: "start", payload: {objective: "Ship it", takeOverTerminal: true}};
  const started = rpc.command(command);
  assert.equal(rpc.isActive(), true, "terminal reconnects must be blocked during handoff");
  assert.equal(spawned, false);
  await assert.rejects(rpc.command({...command, operationId: "duplicate"}), /goal_command_in_progress/);
  release();
  assert.equal((await started).accepted, true);
  assert.equal(spawned, true);
  await rpc.stop();
  assert.equal(rpc.isActive(), false);
  assert.equal((await rpc.snapshot()).status, "stopped");
});

test("a dialog before the prompt response acknowledges delivery without a timeout deadlock", async () => {
  const child = fakePiProcess();
  let promptId;
  child.stdin = new Writable({write(chunk, _encoding, callback) {
    const message = JSON.parse(String(chunk));
    if (message.type === "prompt") {
      promptId = message.id;
      child.stdout.write(JSON.stringify({type: "extension_ui_request", id: "early-dialog", method: "select", title: "Existing draft", options: ["Resume"]}) + "\n");
    } else {
      child.stdout.write(JSON.stringify({type: "response", id: promptId, success: true}) + "\n");
    }
    callback();
  }});
  const rpc = createGoalsRpcService({config: {harnessId: "pi"}, env: {GOAL_RPC_ENABLED: "true"}, spawn: () => child});
  const result = await rpc.command({type: "command", operationId: "early", goalId: "goal-1", action: "start", payload: {objective: "Ship it"}});
  assert.equal(result.accepted, true);
  assert.equal((await rpc.snapshot()).pendingUiRequests[0].id, "early-dialog");
  await rpc.command({type: "answer", operationId: "answer", goalId: "goal-1", questionId: "early-dialog", requestId: "early-dialog", answer: "Resume"});
  assert.equal((await rpc.snapshot()).pendingUiRequests.length, 0);
  await rpc.stop();
});

test("model failures remain visible after agent_end", async () => {
  const child = fakePiProcess();
  const rpc = createGoalsRpcService({config: {harnessId: "pi"}, env: {GOAL_RPC_ENABLED: "true"}, spawn: () => child});
  await rpc.command({type: "command", operationId: "error", goalId: "goal-1", action: "start", payload: {objective: "Ship it"}});
  child.stdout.write(JSON.stringify({type: "message_end", message: {role: "assistant", stopReason: "error", errorMessage: "No API key for selected model"}}) + "\n");
  child.stdout.write('{"type":"agent_end"}\n');
  const snapshot = await rpc.snapshot();
  assert.equal(snapshot.status, "error");
  assert.match(snapshot.lastError, /No API key/);
  await rpc.stop();
});
