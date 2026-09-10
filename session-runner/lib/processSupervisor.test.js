"use strict";

const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const test = require("node:test");
const {createProcessSupervisor} = require("./processSupervisor");

test("tracks and stops runner-owned children at one bounded stop boundary", async () => {
  const child = new EventEmitter();
  child.pid = 123;
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 0;
    child.emit("exit", 0, "SIGTERM");
  };
  const supervisor = createProcessSupervisor({stopTimeoutMs: 20});
  supervisor.register(child, {id: "fixture", label: "fixture-child"});
  assert.equal(supervisor.snapshot().count, 1);
  await supervisor.stopAll("test");
  assert.equal(supervisor.snapshot().count, 0);
});

test("reports unresolved ownership when a child ignores termination", async () => {
  const child = new EventEmitter();
  child.pid = 456;
  child.exitCode = null;
  child.kill = () => {};
  const supervisor = createProcessSupervisor({stopTimeoutMs: 5, logger: {error() {}}});
  supervisor.register(child, {id: "stalled", label: "stalled-child"});
  await assert.rejects(supervisor.stopAll("test"), {code: "execution_child_termination_unresolved"});
  assert.equal(supervisor.snapshot().count, 1);
});
