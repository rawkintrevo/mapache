"use strict";

const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const test = require("node:test");
const {registerRunnerSignals} = require("./runnerSignals");

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`${signal} waits for shutdown and coalesces overlapping signals`, async () => {
    const processImpl = new EventEmitter();
    const calls = [];
    let finish;
    const exited = new Promise((resolve) => { processImpl.exit = resolve; });
    registerRunnerSignals({processImpl, budgetMs: 8000, logger: {log() {}, error: assert.fail},
      runnerLifecycle: {shutdownWithBudget: (options) => {
        calls.push(options);
        return new Promise((resolve) => { finish = resolve; });
      }},
    });
    processImpl.emit(signal);
    processImpl.emit(signal === "SIGTERM" ? "SIGINT" : "SIGTERM");
    await new Promise(setImmediate);
    assert.deepEqual(calls, [{reason: signal, budgetMs: 8000}]);
    finish();
    assert.equal(await exited, 0);
  });
}

test("shutdown failure is logged before exiting", async () => {
  const processImpl = new EventEmitter();
  const events = [];
  const exited = new Promise((resolve) => { processImpl.exit = (code) => { events.push(code); resolve(); }; });
  const failure = new Error("checkpoint_timeout");
  registerRunnerSignals({processImpl, budgetMs: 8000,
    logger: {log() {}, error: (_message, error) => events.push(error)},
    runnerLifecycle: {shutdownWithBudget: () => { throw failure; }},
  });
  processImpl.emit("SIGTERM");
  await exited;
  assert.deepEqual(events, [failure, 0]);
});
