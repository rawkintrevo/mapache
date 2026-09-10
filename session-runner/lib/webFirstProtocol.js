"use strict";

const crypto = require("node:crypto");

const WEB_FIRST_PROTOCOL_VERSION = 1;
const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 48 * 1024;
const MAX_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 16 * 1024;

const COMMAND_TYPES = Object.freeze([
  "prompt",
  "stop",
  "pause",
  "dialog_answer",
  "control_acquire",
  "control_resume",
  "control_revoke",
  "control_handoff",
  "control_complete",
  "heartbeat",
]);

const PROCESSING_STATES = Object.freeze([
  "recorded",
  "dispatch_committed",
  "invocation_observed",
  "executing",
  "interrupted",
  "outcome_unknown",
  "execution_finished",
]);

const OUTCOMES = Object.freeze([
  "pending",
  "success",
  "failure",
  "canceled",
  "handed_to_terminal",
  "unknown",
]);

const DURABILITY_STATES = Object.freeze([
  "not_checkpointed",
  "checkpoint_committed",
]);

function normalizeCommandEnvelope(value, options = {}) {
  if (Buffer.isBuffer(value) && value.length > MAX_ENVELOPE_BYTES) {
    throw protocolError("message_too_large");
  }
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : parseJson(value);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw protocolError("invalid_envelope");
  if (Buffer.byteLength(JSON.stringify(raw), "utf8") > MAX_ENVELOPE_BYTES) {
    throw protocolError("message_too_large");
  }

  const protocolVersion = integer(raw.protocolVersion, "invalid_protocol_version");
  if (protocolVersion !== WEB_FIRST_PROTOCOL_VERSION) throw protocolError("protocol_unsupported");
  const runtimeId = boundedId(raw.runtimeId, "runtime_id_missing");
  const executionEpoch = positiveInteger(raw.executionEpoch, "execution_epoch_invalid");
  const sessionGeneration = positiveInteger(raw.sessionGeneration, "session_generation_invalid");
  const controlEpoch = positiveInteger(raw.controlEpoch, "control_epoch_invalid");
  const commandId = boundedId(raw.commandId, "command_id_missing");
  const type = String(raw.type || "").trim();
  if (!COMMAND_TYPES.includes(type)) throw protocolError("unknown_command_type");

  const payload = normalizePayload(raw.payload, type);
  if (options.runtimeId && runtimeId !== options.runtimeId) throw protocolError("stale_runtime");
  if (options.executionEpoch !== undefined && executionEpoch !== options.executionEpoch) {
    throw protocolError("stale_execution_epoch");
  }
  if (options.sessionGeneration !== undefined && sessionGeneration !== options.sessionGeneration) {
    throw protocolError("stale_session_generation");
  }
  if (type === "prompt" && !payload.message) throw protocolError("prompt_missing");
  if (["stop", "pause", "dialog_answer"].includes(type) && !payload.runId) {
    throw protocolError("run_id_missing");
  }
  if (type === "dialog_answer" && !payload.dialogRequestId) {
    throw protocolError("dialog_request_id_missing");
  }

  return {
    protocolVersion,
    runtimeId,
    executionEpoch,
    sessionGeneration,
    controlEpoch,
    commandId,
    runId: payload.runId || null,
    type,
    payload,
  };
}

function normalizePayload(value, type) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw protocolError("invalid_payload");
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) throw protocolError("payload_too_large");

  const payload = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) throw protocolError("invalid_payload_field");
    payload[key] = item;
  }
  if (type === "prompt") {
    const message = boundedText(value.message, "prompt_invalid");
    if (message && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u001b]/.test(message)) {
      throw protocolError("prompt_invalid");
    }
    payload.message = message;
  }
  if (["stop", "pause"].includes(type)) payload.runId = boundedId(value.runId, "run_id_missing");
  if (type === "dialog_answer") {
    payload.runId = boundedId(value.runId, "run_id_missing");
    payload.dialogRequestId = boundedId(value.dialogRequestId, "dialog_request_id_missing");
    if (!Object.prototype.hasOwnProperty.call(value, "response")) throw protocolError("response_missing");
    payload.response = boundedJsonValue(value.response, MAX_TEXT_LENGTH, "response_invalid");
  }
  return payload;
}

function semanticPayloadHash(payload) {
  return crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function createOperationRecord(envelope, options = {}) {
  const now = options.now || new Date().toISOString();
  return {
    commandId: envelope.commandId,
    payloadHash: semanticPayloadHash(envelope.payload),
    type: envelope.type,
    parentRunId: envelope.runId,
    runId: envelope.type === "prompt" ? envelope.runId || `run-${envelope.commandId}` : envelope.runId,
    runtimeId: envelope.runtimeId,
    executionEpoch: envelope.executionEpoch,
    sessionGeneration: envelope.sessionGeneration,
    controlEpoch: envelope.controlEpoch,
    processing: "recorded",
    outcome: "pending",
    durability: "not_checkpointed",
    dispatchPermit: "unused",
    evidenceIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

function boundedJsonValue(value, maxTextLength, code, depth = 0) {
  if (depth > 8) throw protocolError(code);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (value.length > maxTextLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw protocolError(code);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw protocolError(code);
    return value.map((item) => boundedJsonValue(item, maxTextLength, code, depth + 1));
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > 100) throw protocolError(code);
    return Object.fromEntries(keys.map((key) => [key, boundedJsonValue(value[key], maxTextLength, code, depth + 1)]));
  }
  throw protocolError(code);
}

function boundedText(value, code) {
  if (typeof value !== "string") throw protocolError(code);
  const text = value.trim();
  if (!text || text.length > MAX_TEXT_LENGTH) throw protocolError(code);
  return text;
}

function boundedId(value, code) {
  if (typeof value !== "string") throw protocolError(code);
  const id = value.trim();
  if (!id || id.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(id)) throw protocolError(code);
  return id;
}

function integer(value, code) {
  if (!Number.isSafeInteger(value)) throw protocolError(code);
  return value;
}

function positiveInteger(value, code) {
  const number = integer(value, code);
  if (number < 1) throw protocolError(code);
  return number;
}

function parseJson(value) {
  try {
    return JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : String(value));
  } catch {
    throw protocolError("invalid_json");
  }
}

function protocolError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {
  COMMAND_TYPES,
  DURABILITY_STATES,
  MAX_ENVELOPE_BYTES,
  MAX_PAYLOAD_BYTES,
  OUTCOMES,
  PROCESSING_STATES,
  WEB_FIRST_PROTOCOL_VERSION,
  boundedJsonValue,
  canonicalJson,
  createOperationRecord,
  normalizeCommandEnvelope,
  protocolError,
  semanticPayloadHash,
};
