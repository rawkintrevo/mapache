"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createMemoryOperationStore, createOperationLedger} = require("./operationLedger");
const {WEB_FIRST_PROTOCOL_VERSION, normalizeCommandEnvelope} = require("./webFirstProtocol");

function envelope(overrides = {}) {
  return normalizeCommandEnvelope({
    protocolVersion: WEB_FIRST_PROTOCOL_VERSION,
    runtimeId: "runtime-1",
    executionEpoch: 1,
    sessionGeneration: 1,
    controlEpoch: 2,
    commandId: "command-1",
    type: "prompt",
    payload: {message: "hello"},
    ...overrides,
  });
}

test("deduplicates identical command ids and returns a stable conflict for changed payloads", async () => {
  const ledger = createOperationLedger({store: createMemoryOperationStore()});
  await ledger.initialize();
  const first = await ledger.admit(envelope());
  const duplicate = await ledger.admit(envelope());
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(() => ledger.admit(envelope({payload: {message: "changed"}})), (error) => error.code === "operation_conflict");
});

test("consumes a dispatch permit once and keeps quiescence separate from success", async () => {
  const ledger = createOperationLedger({store: createMemoryOperationStore()});
  await ledger.initialize();
  await ledger.admit(envelope());
  const first = await ledger.consumeDispatchPermit("command-1", {runtimeId: "runtime-1", executionEpoch: 1, sessionGeneration: 1});
  const second = await ledger.consumeDispatchPermit("command-1", {runtimeId: "runtime-1", executionEpoch: 1, sessionGeneration: 1});
  assert.equal(first.consumed, true);
  assert.equal(second.consumed, false);
  await ledger.recordEvidence("command-1", {type: "agent_settled", id: "settled-1"});
  assert.equal(ledger.get("command-1").processing, "outcome_unknown");
  assert.equal(ledger.get("command-1").outcome, "unknown");
  assert.notEqual(ledger.get("command-1").outcome, "success");
});

test("retains a root reservation until explicit release", async () => {
  const ledger = createOperationLedger({store: createMemoryOperationStore()});
  await ledger.initialize();
  await ledger.admit(envelope());
  await assert.rejects(() => ledger.admit(envelope({commandId: "command-2"})), (error) => error.code === "operation_in_progress");
  assert.equal(await ledger.releaseRoot("run-command-1", {commandId: "command-1"}), true);
  await ledger.admit(envelope({commandId: "command-2"}));
});
