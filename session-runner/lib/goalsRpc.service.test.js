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
