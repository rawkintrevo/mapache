"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createWorkspaceSyncCoordinator} = require("./workspaceSyncCoordinator");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return {promise, resolve};
}

test("serializes sync directions and coalesces queued periodic uploads", async () => {
  const events = [];
  const gates = [];
  const coordinator = createWorkspaceSyncCoordinator({
    syncUp: async (options) => {
      events.push(`up:start:${options.includeArchives}`);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      events.push("up:end");
    },
    syncDown: async () => {
      events.push("down:start");
      events.push("down:end");
    },
  });

  const first = coordinator.syncUp();
  const second = coordinator.syncUp();
  const final = coordinator.syncUp({includeArchives: true});
  const down = coordinator.syncDown();
  assert.notEqual(first, second);
  assert.equal(second, final);
  assert.deepEqual(events, ["up:start:false"]);

  gates.shift().resolve();
  await first;
  await down;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["up:start:false", "up:end", "down:start", "down:end", "up:start:true"]);
  gates.shift().resolve();
  await second;
  assert.deepEqual(events, ["up:start:false", "up:end", "down:start", "down:end", "up:start:true", "up:end"]);
});

test("a final archive sync is awaited and never dropped", async () => {
  const gate = deferred();
  let includeArchives = false;
  const coordinator = createWorkspaceSyncCoordinator({
    syncUp: async (options) => {
      includeArchives = options.includeArchives;
      await gate.promise;
    },
    syncDown: async () => {},
  });
  const final = coordinator.syncUp({includeArchives: true});
  let settled = false;
  final.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(includeArchives, true);
  gate.resolve();
  await final;
  assert.equal(settled, true);
});

test("reader sessions skip uploads but keep an explicit status result", async () => {
  const events = [];
  const logs = [];
  const coordinator = createWorkspaceSyncCoordinator({
    syncUp: async () => events.push("uploaded"),
    syncDown: async () => events.push("downloaded"),
    syncWriterRole: "reader",
    logger: {log: (message) => logs.push(message)},
  });

  assert.deepEqual(await coordinator.syncUp({includeArchives: true}), {
    conflicts: [],
    role: "reader",
    skipped: "sync_writer_lease",
  });
  assert.deepEqual(await coordinator.syncUp(), {
    conflicts: [],
    role: "reader",
    skipped: "sync_writer_lease",
  });
  await coordinator.syncDown();
  assert.deepEqual(events, ["downloaded"]);
  assert.deepEqual(logs, ["workspace sync up skipped: sync-writer role is reader"]);
});
