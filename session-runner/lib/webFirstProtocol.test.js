"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_ENVELOPE_BYTES,
  WEB_FIRST_PROTOCOL_VERSION,
  normalizeCommandEnvelope,
  semanticPayloadHash,
} = require("./webFirstProtocol");

function valid(overrides = {}) {
  return {
    protocolVersion: WEB_FIRST_PROTOCOL_VERSION,
    runtimeId: "runtime-1",
    executionEpoch: 1,
    sessionGeneration: 1,
    controlEpoch: 1,
    commandId: "command-1",
    type: "prompt",
    payload: {message: "hello"},
    ...overrides,
  };
}

test("validates command identities and bounded payloads", () => {
  assert.deepEqual(normalizeCommandEnvelope(valid()), {
    protocolVersion: 1,
    runtimeId: "runtime-1",
    executionEpoch: 1,
    sessionGeneration: 1,
    controlEpoch: 1,
    commandId: "command-1",
    runId: null,
    type: "prompt",
    payload: {message: "hello"},
  });
  assert.throws(() => normalizeCommandEnvelope(valid({runtimeId: ""})), (error) => error.code === "runtime_id_missing");
  assert.throws(() => normalizeCommandEnvelope(valid({type: "not-a-command"})), (error) => error.code === "unknown_command_type");
  assert.throws(() => normalizeCommandEnvelope(valid({payload: {message: ""}})), (error) => error.code === "prompt_invalid");
  assert.throws(() => normalizeCommandEnvelope(valid({payload: {message: "x\u0000"}})), (error) => error.code === "prompt_invalid");
  assert.throws(() => normalizeCommandEnvelope(JSON.stringify({x: "x".repeat(MAX_ENVELOPE_BYTES)})), (error) => error.code === "message_too_large");
});

test("requires correlated identities for controls and answers", () => {
  assert.throws(() => normalizeCommandEnvelope(valid({type: "stop", payload: {}})), (error) => error.code === "run_id_missing");
  assert.throws(() => normalizeCommandEnvelope({
    ...valid(),
    type: "dialog_answer",
    payload: {runId: "run-1", response: "yes"},
  }), (error) => error.code === "dialog_request_id_missing");
  assert.equal(normalizeCommandEnvelope({
    ...valid(),
    type: "dialog_answer",
    payload: {runId: "run-1", dialogRequestId: "dialog-1", response: "yes"},
  }).runId, "run-1");
});

test("semantic hashes ignore object key order", () => {
  assert.equal(
      semanticPayloadHash({a: 1, nested: {z: true, a: "x"}}),
      semanticPayloadHash({nested: {a: "x", z: true}, a: 1}),
  );
});
