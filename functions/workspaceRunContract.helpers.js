"use strict";

const MAX_ID_LENGTH = 200;
const MAX_REFERENCE_LENGTH = 512;
const MAX_INSTRUCTIONS_LENGTH = 32768;
const MAX_CONTEXT_REFS = 32;
const MAX_SINKS = 16;
const TRIGGER_KINDS = Object.freeze([
  "cron", "manual", "http_ticket", "restart", "retry", "catch_up",
]);
const SECRET_KEY_PATTERN = /(secret|token|password|credential|api[_-]?key|private[_-]?key)/i;

function contractError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizeWorkspaceRunRequest(input = {}) {
  if (!isPlainObject(input)) throw contractError("invalid_workspace_run_request");
  const targetWorkspaceId = boundedString(input.targetWorkspaceId, "target_workspace_id", MAX_ID_LENGTH);
  const triggerKind = boundedString(input.triggerKind, "trigger_kind", 32).toLowerCase();
  if (!TRIGGER_KINDS.includes(triggerKind)) throw contractError("invalid_workspace_run_trigger");

  const actor = normalizeIdentity(input.actor, "actor");
  const source = normalizeIdentity(input.source || actor, "source");
  const triggerReference = optionalString(input.triggerReference, "trigger_reference", MAX_REFERENCE_LENGTH);
  const instructions = boundedString(input.instructions, "instructions", MAX_INSTRUCTIONS_LENGTH, {trim: false});
  const inputData = input.input === undefined ? null : normalizePublicValue(input.input, "input");
  const contextSnapshotRefs = normalizeContextRefs(input.contextSnapshotRefs);
  const model = input.model === undefined || input.model === null ? null : normalizePublicValue(input.model, "model");
  const resources = input.resources === undefined || input.resources === null ? null : normalizePublicValue(input.resources, "resources");
  const sinks = normalizeSinks(input.sinks);
  const provenance = normalizeProvenance(input.provenance, source, triggerReference);

  return {
    targetWorkspaceId,
    actor,
    source,
    triggerKind,
    triggerReference: triggerReference || null,
    instructions,
    input: inputData,
    contextSnapshotRefs,
    model,
    resources,
    sinks,
    provenance,
  };
}

function contextSnapshotRefsForWorkspace(workspace = {}) {
  const refs = [];
  const files = workspace.agentRuntimeWorkspaceFiles;
  if (files?.manifest) {
    refs.push({
      kind: "workspace_files",
      version: String(files.manifest.generation || files.manifest.checksum || files.manifest.objectPath || "latest"),
      source: "workspace_snapshot",
      ...(files.manifest.createdAt ? {freshness: String(files.manifest.createdAt)} : {}),
    });
  } else if (workspace.agentUiVersion === "pi-web-ui-v1") {
    refs.push({kind: "workspace_files", version: "empty", source: "workspace_snapshot", freshness: "no_saved_snapshot"});
  }
  if (workspace.agentRuntimeSettings?.version) {
    refs.push({kind: "agent_settings", version: String(workspace.agentRuntimeSettings.version), source: "workspace_settings"});
  }
  if (workspace.chromeProfileSeed?.version || workspace.chromeProfileSeed?.objectGeneration) {
    refs.push({
      kind: "browser_profile",
      version: String(workspace.chromeProfileSeed.version || workspace.chromeProfileSeed.objectGeneration),
      source: "browser_seed",
      ...(workspace.chromeProfileSeed.capturedAt ? {freshness: String(workspace.chromeProfileSeed.capturedAt)} : {}),
    });
  }
  return refs;
}

function fromAutomationRun({workspaceId, ownerUid, trigger, occurrence, snapshot, request = {}} = {}) {
  return normalizeWorkspaceRunRequest({
    targetWorkspaceId: workspaceId,
    actor: request.actor || {type: "workspace_owner", id: ownerUid},
    source: request.source,
    triggerKind: trigger,
    triggerReference: request.triggerReference || occurrence?.local || null,
    instructions: request.instructions || snapshot?.prompt,
    input: request.input,
    contextSnapshotRefs: request.contextSnapshotRefs || [],
    model: request.model === undefined ? snapshot?.modelSelection || null : request.model,
    resources: request.resources === undefined ? snapshot?.resources || null : request.resources,
    sinks: request.sinks || [{kind: "workspace_output", reference: workspaceId}],
    provenance: request.provenance,
  });
}

function normalizeIdentity(value, field) {
  if (!isPlainObject(value)) throw contractError(`invalid_workspace_run_${field}`);
  const type = boundedString(value.type, `${field}_type`, 64);
  const id = boundedString(value.id, `${field}_id`, MAX_ID_LENGTH);
  return {type, id};
}

function normalizeContextRefs(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_CONTEXT_REFS) throw contractError("invalid_workspace_run_context_refs");
  return value.map((entry) => {
    if (!isPlainObject(entry)) throw contractError("invalid_workspace_run_context_ref");
    const normalized = {
      kind: boundedString(entry.kind, "context_kind", 64),
      version: boundedString(entry.version, "context_version", MAX_REFERENCE_LENGTH),
      source: boundedString(entry.source, "context_source", MAX_REFERENCE_LENGTH),
    };
    if (entry.freshness !== undefined && entry.freshness !== null) {
      normalized.freshness = boundedString(entry.freshness, "context_freshness", MAX_REFERENCE_LENGTH);
    }
    return normalized;
  });
}

function normalizeSinks(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SINKS) throw contractError("invalid_workspace_run_sinks");
  return value.map((sink) => {
    if (!isPlainObject(sink)) throw contractError("invalid_workspace_run_sink");
    const normalized = {kind: boundedString(sink.kind, "sink_kind", 64)};
    if (sink.reference !== undefined && sink.reference !== null) {
      normalized.reference = boundedString(sink.reference, "sink_reference", MAX_REFERENCE_LENGTH);
    }
    return normalized;
  });
}

function normalizeProvenance(value, source, triggerReference) {
  if (value === undefined || value === null) {
    return {source: source.type, reference: triggerReference || null};
  }
  if (!isPlainObject(value)) throw contractError("invalid_workspace_run_provenance");
  return {
    source: boundedString(value.source || source.type, "provenance_source", 64),
    reference: optionalString(value.reference, "provenance_reference", MAX_REFERENCE_LENGTH) || triggerReference || null,
  };
}

function normalizePublicValue(value, field) {
  if (containsSecretKey(value)) throw contractError("workspace_run_secret_in_public_request", {field});
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => normalizePublicValue(entry, field));
  if (!isPlainObject(value)) throw contractError(`invalid_workspace_run_${field}`);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizePublicValue(entry, field)]));
}

function containsSecretKey(value) {
  if (Array.isArray(value)) return value.some(containsSecretKey);
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, entry]) => SECRET_KEY_PATTERN.test(key) || containsSecretKey(entry));
}

function boundedString(value, field, maxLength, options = {}) {
  if (typeof value !== "string") throw contractError(`invalid_workspace_run_${field}`);
  const normalized = options.trim === false ? value : value.trim();
  if (!normalized || normalized.length > maxLength) throw contractError(`invalid_workspace_run_${field}`);
  return normalized;
}

function optionalString(value, field, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  return boundedString(value, field, maxLength);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  TRIGGER_KINDS,
  contextSnapshotRefsForWorkspace,
  fromAutomationRun,
  normalizeWorkspaceRunRequest,
};
