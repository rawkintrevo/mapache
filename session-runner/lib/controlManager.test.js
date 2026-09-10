"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createControlManager} = require("./controlManager");

function setup() {
  let time = 1000;
  const manager = createControlManager({
    runtimeId: "runtime-1",
    executionEpoch: 7,
    now: () => time,
    heartbeatMs: 10,
    leaseMs: 30,
    randomBytes: () => Buffer.alloc(32, "a"),
  });
  return {manager, advance: (ms) => { time += ms; }};
}

test("binds a tab to a secret and prevents copied-client takeover", () => {
  const {manager} = setup();
  const first = manager.bindConnection({clientId: "tab-1", connectionId: "connection-1"});
  manager.acquire({clientId: "tab-1", resumptionSecret: first.resumptionSecret, connectionId: "connection-1"});
  assert.throws(() => manager.bindConnection({clientId: "tab-1", connectionId: "connection-2"}), (error) => error.code === "control_binding_invalid");
  assert.throws(() => manager.bindConnection({clientId: "tab-1", resumptionSecret: first.resumptionSecret, connectionId: "connection-2"}), (error) => error.code === "control_binding_in_use");
  assert.throws(() => manager.assertCanWrite({clientId: "tab-1", resumptionSecret: first.resumptionSecret, connectionId: "connection-2"}), (error) => error.code === "control_connection_invalid");
});

test("allows one owner and rejects a competing acquisition", () => {
  const {manager} = setup();
  const first = manager.bindConnection({clientId: "tab-1", connectionId: "connection-1"});
  const second = manager.bindConnection({clientId: "tab-2", connectionId: "connection-2"});
  manager.acquire({clientId: "tab-1", resumptionSecret: first.resumptionSecret, connectionId: "connection-1"});
  assert.throws(() => manager.acquire({clientId: "tab-2", resumptionSecret: second.resumptionSecret, connectionId: "connection-2"}), (error) => error.code === "control_busy");
  assert.equal(manager.snapshot().controllerClientId, "tab-1");
});

test("disconnect removes write admission but preserves a resumable lease until expiry", () => {
  const {manager, advance} = setup();
  const first = manager.bindConnection({clientId: "tab-1", connectionId: "connection-1"});
  manager.acquire({clientId: "tab-1", resumptionSecret: first.resumptionSecret, connectionId: "connection-1"});
  manager.disconnect("connection-1");
  assert.throws(() => manager.assertCanWrite({clientId: "tab-1", resumptionSecret: first.resumptionSecret, connectionId: "connection-1"}), (error) => error.code === "control_connection_invalid");
  const resumed = manager.bindConnection({clientId: "tab-1", resumptionSecret: first.resumptionSecret, connectionId: "connection-3"});
  assert.equal(resumed.resumed, true);
  manager.acquire({clientId: "tab-1", resumptionSecret: first.resumptionSecret, connectionId: "connection-3"});
  advance(31);
  manager.tick();
  assert.equal(manager.snapshot().state, "unowned");
});

test("a run retains the single-flight slot while temporarily idle", () => {
  const {manager} = setup();
  const first = manager.bindConnection({clientId: "tab-1", connectionId: "connection-1"});
  manager.acquire({clientId: "tab-1", resumptionSecret: first.resumptionSecret, connectionId: "connection-1"});
  manager.reserveRun({runId: "run-1", clientId: "tab-1", resumptionSecret: first.resumptionSecret, connectionId: "connection-1"});
  assert.equal(manager.snapshot().activeRun.runId, "run-1");
  assert.equal(manager.isSafeBoundary(), false);
  manager.beginHandoff({clientId: "tab-1", resumptionSecret: first.resumptionSecret, connectionId: "connection-1"});
  assert.throws(() => manager.completeHandoff({clientId: "tab-1", resumptionSecret: first.resumptionSecret, connectionId: "connection-1", safe: true}), (error) => error.code === "control_connection_invalid");
  manager.releaseRun("run-1");
  const second = manager.bindConnection({clientId: "tab-2", connectionId: "connection-2"});
  manager.completeHandoff({clientId: "tab-2", resumptionSecret: second.resumptionSecret, connectionId: "connection-2", safe: true});
  assert.equal(manager.isSafeBoundary(), true);
});
