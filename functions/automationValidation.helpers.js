"use strict";

const {normalizeSessionResources} = require("./sessionResources.helpers");

const AUTOMATION_NAME_MAX_LENGTH = 120;
const AUTOMATION_PROMPT_MAX_LENGTH = 32768;
const AUTOMATION_CRON_MAX_LENGTH = 100;
const AUTOMATION_TIMEZONE_MAX_LENGTH = 100;
const AUTOMATION_ID_MAX_LENGTH = 200;
const AUTOMATION_REVISION_MIN = 1;
const DEFAULT_AUTOMATION_MAX_CONCURRENCY = 1;

const AUTOMATION_MUTABLE_FIELDS = Object.freeze([
  "name",
  "prompt",
  "enabled",
  "cron",
  "timezone",
  "allowParallelWithMain",
  "modelId",
  "providerId",
  "modelSelection",
  "resources",
]);

const AUTOMATION_SERVER_FIELDS = Object.freeze([
  "id",
  "ownerUid",
  "workspaceId",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "deleted",
  "revision",
  "nextRunAt",
  "lastRunAt",
  "lastRunId",
  "status",
  "cleanupState",
  "sessionId",
  "conversationId",
  "runId",
  "trigger",
  "snapshot",
  "artifactPointers",
]);

const AUTOMATION_RUN_TRIGGERS = Object.freeze(["cron", "manual", "restart"]);
const AUTOMATION_RUN_STATUSES = Object.freeze([
  "queued",
  "provisioning",
  "running",
  "stopping",
  "succeeded",
  "failed",
  "canceled",
  "interrupted",
  "skipped",
]);
const AUTOMATION_CLEANUP_STATES = Object.freeze(["pending", "complete", "error"]);
const AUTOMATION_SKIPPED_REASONS = Object.freeze([
  "queue_full",
  "missed_range",
  "disabled",
  "deleted",
  "duplicate_occurrence",
  "concurrency_limit",
  "invalid_schedule",
]);

function validationError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requirePlainObject(value, code = "invalid_automation_payload") {
  if (!isPlainObject(value)) throw validationError(code);
  return value;
}

function normalizedString(value, field, maxLength, options = {}) {
  if (value === undefined || value === null) {
    if (options.required === false) return "";
    throw validationError(`invalid_automation_${field}`);
  }
  if (typeof value !== "string") throw validationError(`invalid_automation_${field}`);
  const normalized = options.trim === false ? value : value.trim();
  if ((!normalized && options.required !== false) || normalized.length > maxLength) {
    throw validationError(`invalid_automation_${field}`);
  }
  return normalized;
}

function validateAutomationName(value) {
  return normalizedString(value, "name", AUTOMATION_NAME_MAX_LENGTH);
}

function validateAutomationPrompt(value) {
  const normalized = normalizedString(value, "prompt", AUTOMATION_PROMPT_MAX_LENGTH, {trim: false});
  if (!normalized.trim()) throw validationError("invalid_automation_prompt");
  return normalized;
}

function validateAutomationCron(value, options = {}) {
  return normalizedString(value, "cron", AUTOMATION_CRON_MAX_LENGTH, options);
}

function validateAutomationTimezone(value, options = {}) {
  return normalizedString(value, "timezone", AUTOMATION_TIMEZONE_MAX_LENGTH, options);
}

function validateAutomationId(value, field = "id") {
  return normalizedString(value, field, AUTOMATION_ID_MAX_LENGTH);
}

function validateDefinitionRevision(value) {
  if (!Number.isSafeInteger(value) || value < AUTOMATION_REVISION_MIN) {
    throw validationError("invalid_automation_revision");
  }
  return value;
}

function validateAutomationMaxConcurrency(value = DEFAULT_AUTOMATION_MAX_CONCURRENCY) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw validationError("invalid_automation_max_concurrency");
  }
  return value;
}

function validateBoolean(value, field) {
  if (typeof value !== "boolean") throw validationError(`invalid_automation_${field}`);
  return value;
}

function normalizeModelSelection(payload = {}) {
  const selection = payload.modelSelection;
  const hasLegacyFields = Object.prototype.hasOwnProperty.call(payload, "modelId") ||
    Object.prototype.hasOwnProperty.call(payload, "providerId");
  if (selection === undefined && !hasLegacyFields) return null;
  if (selection === null && !hasLegacyFields) return null;
  if (selection !== undefined) requirePlainObject(selection, "invalid_automation_model_selection");
  const source = selection || payload;
  const keys = Object.keys(source);
  if (keys.some((key) => !["modelId", "providerId"].includes(key))) {
    throw validationError("invalid_automation_model_selection");
  }
  const modelId = normalizedString(source.modelId, "model_id", 256, {required: false});
  const providerId = normalizedString(source.providerId, "provider_id", 256, {required: false});
  if (!modelId && !providerId) throw validationError("invalid_automation_model_selection");
  return {modelId: modelId || null, providerId: providerId || null};
}

function normalizeAutomationResources(value) {
  if (value === undefined || value === null) return null;
  requirePlainObject(value, "invalid_automation_resources");
  const keys = Object.keys(value);
  if (keys.some((key) => !["cpu", "memory"].includes(key))) {
    throw validationError("invalid_automation_resources");
  }
  try {
    return normalizeSessionResources(value, {defaultResources: null});
  } catch (error) {
    throw validationError("invalid_automation_resources", {reason: error.reason || error.code});
  }
}

function assertNoServerOwnedFields(payload) {
  const serverFields = new Set(AUTOMATION_SERVER_FIELDS);
  for (const key of Object.keys(payload || {})) {
    if (serverFields.has(key)) throw validationError("automation_server_field", {field: key});
  }
}

function assertKnownMutableFields(payload) {
  const mutableFields = new Set(AUTOMATION_MUTABLE_FIELDS);
  for (const key of Object.keys(payload || {})) {
    if (!mutableFields.has(key)) throw validationError("unknown_automation_field", {field: key});
  }
}

function normalizeAutomationMutation(payload = {}, options = {}) {
  requirePlainObject(payload);
  assertNoServerOwnedFields(payload);
  assertKnownMutableFields(payload);
  const normalized = {};
  if (Object.prototype.hasOwnProperty.call(payload, "name")) normalized.name = validateAutomationName(payload.name);
  if (Object.prototype.hasOwnProperty.call(payload, "prompt")) normalized.prompt = validateAutomationPrompt(payload.prompt);
  if (Object.prototype.hasOwnProperty.call(payload, "enabled")) normalized.enabled = validateBoolean(payload.enabled, "enabled");
  if (Object.prototype.hasOwnProperty.call(payload, "cron")) normalized.cron = validateAutomationCron(payload.cron);
  if (Object.prototype.hasOwnProperty.call(payload, "timezone")) normalized.timezone = validateAutomationTimezone(payload.timezone);
  if (Object.prototype.hasOwnProperty.call(payload, "allowParallelWithMain")) {
    normalized.allowParallelWithMain = validateBoolean(payload.allowParallelWithMain, "allow_parallel_with_main");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "modelSelection") ||
      Object.prototype.hasOwnProperty.call(payload, "modelId") ||
      Object.prototype.hasOwnProperty.call(payload, "providerId")) {
    normalized.modelSelection = normalizeModelSelection(payload);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "resources")) normalized.resources = normalizeAutomationResources(payload.resources);
  if (!options.partial) {
    for (const field of ["name", "prompt", "cron", "timezone"]) {
      if (!Object.prototype.hasOwnProperty.call(normalized, field)) throw validationError(`missing_automation_${field}`);
    }
    if (!Object.prototype.hasOwnProperty.call(normalized, "enabled")) normalized.enabled = false;
    if (!Object.prototype.hasOwnProperty.call(normalized, "allowParallelWithMain")) normalized.allowParallelWithMain = true;
    if (!Object.prototype.hasOwnProperty.call(normalized, "modelSelection")) normalized.modelSelection = null;
    if (!Object.prototype.hasOwnProperty.call(normalized, "resources")) normalized.resources = null;
  }
  return normalized;
}

function normalizeAutomationDefinition(payload = {}, options = {}) {
  const normalized = normalizeAutomationMutation(payload, options);
  if (options.revision !== undefined) normalized.revision = validateDefinitionRevision(options.revision);
  return normalized;
}

function validateRunTrigger(value) {
  const trigger = String(value || "").trim().toLowerCase();
  if (!AUTOMATION_RUN_TRIGGERS.includes(trigger)) throw validationError("invalid_automation_trigger");
  return trigger;
}

function validateRunStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (!AUTOMATION_RUN_STATUSES.includes(status)) throw validationError("invalid_automation_run_status");
  return status;
}

function validateCleanupState(value) {
  const state = String(value || "").trim().toLowerCase();
  if (!AUTOMATION_CLEANUP_STATES.includes(state)) throw validationError("invalid_automation_cleanup_state");
  return state;
}

function validateSkippedReason(value) {
  const reason = String(value || "").trim().toLowerCase();
  if (!AUTOMATION_SKIPPED_REASONS.includes(reason)) throw validationError("invalid_automation_skipped_reason");
  return reason;
}

function normalizeRunSnapshot(snapshot = {}) {
  requirePlainObject(snapshot, "invalid_automation_run_snapshot");
  const allowed = [
    "name", "prompt", "definitionRevision", "cron", "timezone",
    "allowParallelWithMain", "modelSelection", "resources",
  ];
  if (Object.keys(snapshot).some((key) => !allowed.includes(key))) {
    throw validationError("invalid_automation_run_snapshot");
  }
  const definition = normalizeAutomationMutation({
    name: snapshot.name,
    prompt: snapshot.prompt,
    cron: snapshot.cron,
    timezone: snapshot.timezone,
    allowParallelWithMain: snapshot.allowParallelWithMain,
    modelSelection: snapshot.modelSelection,
    resources: snapshot.resources,
  });
  return {
    name: definition.name,
    prompt: definition.prompt,
    definitionRevision: validateDefinitionRevision(snapshot.definitionRevision),
    cron: definition.cron,
    timezone: definition.timezone,
    allowParallelWithMain: definition.allowParallelWithMain,
    modelSelection: definition.modelSelection,
    resources: definition.resources,
  };
}

function buildAutomationDefinition(payload = {}, server = {}) {
  const normalized = normalizeAutomationDefinition(payload, {revision: server.revision || 1});
  const ownerUid = normalizedString(server.ownerUid, "owner_uid", 256);
  const workspaceId = validateAutomationId(server.workspaceId, "workspace_id");
  return {
    ownerUid,
    workspaceId,
    ...normalized,
    revision: normalized.revision,
    deleted: false,
    deletedAt: null,
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    createdAt: server.createdAt || null,
    updatedAt: server.updatedAt || null,
  };
}

function buildAutomationRun(payload = {}, server = {}) {
  requirePlainObject(payload, "invalid_automation_run");
  const runId = validateAutomationId(server.runId || payload.runId, "run_id");
  const ownerUid = normalizedString(server.ownerUid || payload.ownerUid, "owner_uid", 256);
  const workspaceId = validateAutomationId(server.workspaceId || payload.workspaceId, "workspace_id");
  const automationId = validateAutomationId(server.automationId || payload.automationId, "automation_id");
  const trigger = validateRunTrigger(server.trigger || payload.trigger);
  const snapshot = normalizeRunSnapshot(server.snapshot || payload.snapshot);
  const status = validateRunStatus(server.status || payload.status || "queued");
  const cleanupState = validateCleanupState(server.cleanupState || payload.cleanupState || "pending");
  const run = {
    runId,
    ownerUid,
    workspaceId,
    automationId,
    trigger,
    snapshot,
    status,
    cleanupState,
    createdAt: server.createdAt || payload.createdAt || null,
    queuedAt: server.queuedAt || payload.queuedAt || null,
    startedAt: server.startedAt || payload.startedAt || null,
    endedAt: server.endedAt || payload.endedAt || null,
    updatedAt: server.updatedAt || payload.updatedAt || null,
    restartOfRunId: server.restartOfRunId || payload.restartOfRunId || null,
    sessionId: null,
    conversationId: null,
    artifactPointers: {},
  };
  if (status === "skipped") run.skippedReason = validateSkippedReason(server.skippedReason || payload.skippedReason);
  return run;
}

function normalizeAutomationSettings(payload = {}) {
  requirePlainObject(payload, "invalid_automation_settings");
  const keys = Object.keys(payload);
  if (keys.some((key) => key !== "automationMaxConcurrency")) throw validationError("unknown_automation_settings_field");
  return {
    automationMaxConcurrency: validateAutomationMaxConcurrency(
        payload.automationMaxConcurrency === undefined ? DEFAULT_AUTOMATION_MAX_CONCURRENCY : payload.automationMaxConcurrency,
    ),
  };
}

module.exports = {
  AUTOMATION_CLEANUP_STATES,
  AUTOMATION_CRON_MAX_LENGTH,
  AUTOMATION_ID_MAX_LENGTH,
  AUTOMATION_MUTABLE_FIELDS,
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_PROMPT_MAX_LENGTH,
  AUTOMATION_REVISION_MIN,
  AUTOMATION_RUN_STATUSES,
  AUTOMATION_RUN_TRIGGERS,
  AUTOMATION_SERVER_FIELDS,
  AUTOMATION_SKIPPED_REASONS,
  AUTOMATION_TIMEZONE_MAX_LENGTH,
  DEFAULT_AUTOMATION_MAX_CONCURRENCY,
  assertKnownMutableFields,
  assertNoServerOwnedFields,
  buildAutomationDefinition,
  buildAutomationRun,
  isPlainObject,
  normalizeAutomationDefinition,
  normalizeAutomationMutation,
  normalizeAutomationResources,
  normalizeAutomationSettings,
  normalizeModelSelection,
  normalizeRunSnapshot,
  validateAutomationCron,
  validateAutomationId,
  validateAutomationMaxConcurrency,
  validateAutomationName,
  validateAutomationPrompt,
  validateAutomationTimezone,
  validateCleanupState,
  validateDefinitionRevision,
  validateRunStatus,
  validateRunTrigger,
  validateSkippedReason,
};
