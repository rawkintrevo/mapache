"use strict";

const crypto = require("crypto");
const {httpError} = require("./backendUtils.helpers");

const GOAL_SCHEMA_VERSION = 1;
const GOAL_MODES = new Set(["regular", "sisyphus"]);
const GOAL_LIFECYCLES = new Set(["draft", "ready", "open", "paused", "blocked", "interrupted", "completed", "archived", "failed"]);
const GOAL_ACTIONS = new Set(["start", "pause", "resume", "revise", "archive", "cancel", "focus", "unfocus", "settings"]);
const MAX_GOAL_TITLE_LENGTH = 160;
const MAX_GOAL_OBJECTIVE_LENGTH = 4000;
const MAX_GOAL_ANSWER_LENGTH = 16000;
const MAX_GOAL_PAGE_SIZE = 50;

function normalizeGoalPayload(payload = {}, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError(400, "invalid_goal_payload");
  }
  const objective = String(payload.objective || "").trim();
  if (!objective || objective.length > MAX_GOAL_OBJECTIVE_LENGTH || /\u0000/.test(objective)) {
    throw httpError(400, "invalid_goal_objective");
  }
  const mode = String(payload.mode || "regular").trim().toLowerCase();
  if (!GOAL_MODES.has(mode)) throw httpError(400, "invalid_goal_mode");
  const title = normalizeGoalTitle(payload.title || objective.split(/\r?\n/, 1)[0]);
  const result = {
    title,
    objective,
    mode,
    auditEnabled: payload.auditEnabled !== false,
  };
  if (options.allowRevision && payload.expectedRevision !== undefined) {
    result.expectedRevision = normalizeGoalRevision(payload.expectedRevision);
  }
  return result;
}

function normalizeGoalTitle(value) {
  const title = String(value || "").trim().replace(/\s+/g, " ");
  if (!title || title.length > MAX_GOAL_TITLE_LENGTH || /[\u0000-\u001f\u007f]/.test(title)) {
    throw httpError(400, "invalid_goal_title");
  }
  return title;
}

function normalizeGoalRevision(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) throw httpError(400, "invalid_goal_revision");
  return revision;
}

function normalizeGoalAction(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw httpError(400, "invalid_goal_action");
  const action = String(payload.action || "").trim().toLowerCase();
  if (!GOAL_ACTIONS.has(action)) throw httpError(400, "invalid_goal_action");
  const result = {action};
  if (payload.expectedRevision !== undefined) result.expectedRevision = normalizeGoalRevision(payload.expectedRevision);
  if (payload.operationId !== undefined) result.operationId = normalizeOperationId(payload.operationId);
  if (payload.sessionId !== undefined) {
    const sessionId = String(payload.sessionId || "").trim();
    if (!sessionId || sessionId.length > 256) throw httpError(400, "invalid_goal_session");
    result.sessionId = sessionId;
  }
  if (action === "revise" && payload.objective !== undefined) {
    Object.assign(result, normalizeGoalPayload(payload, {allowRevision: true}));
  }
  if (action === "settings") {
    if (!payload.settings || typeof payload.settings !== "object" || Array.isArray(payload.settings)) {
      throw httpError(400, "invalid_goal_settings");
    }
    result.settings = normalizeGoalSettings(payload.settings);
  }
  return result;
}

function normalizeGoalSettings(value = {}) {
  const settings = {};
  for (const key of ["disableTasks", "disableContracts", "auditorDisabled", "autoSelectSingleGoal"]) {
    if (value[key] !== undefined) settings[key] = Boolean(value[key]);
  }
  if (value.subtaskDepth !== undefined) {
    const depth = Number(value.subtaskDepth);
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > 8) throw httpError(400, "invalid_goal_settings");
    settings.subtaskDepth = depth;
  }
  for (const key of ["provider", "model", "thinkingLevel"]) {
    if (value[key] !== undefined) {
      const text = String(value[key] || "").trim();
      if (text.length > 256 || /[\u0000-\u001f\u007f]/.test(text)) throw httpError(400, "invalid_goal_settings");
      settings[key] = text;
    }
  }
  return settings;
}

function normalizeGoalAnswer(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw httpError(400, "invalid_goal_answer");
  const answer = String(payload.answer || "").trim();
  if (!answer || answer.length > MAX_GOAL_ANSWER_LENGTH || /\u0000/.test(answer)) {
    throw httpError(400, "invalid_goal_answer");
  }
  const requestId = String(payload.requestId || "").trim();
  if (!requestId || requestId.length > 256) throw httpError(400, "invalid_goal_question");
  const expectedRevision = normalizeGoalRevision(payload.expectedRevision ?? 0);
  return {answer, requestId, expectedRevision};
}

function normalizeOperationId(value) {
  const operationId = String(value || "").trim();
  if (!operationId || operationId.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(operationId)) {
    throw httpError(400, "invalid_goal_operation");
  }
  return operationId;
}

function createOperationId() {
  return crypto.randomUUID();
}

function hashGoalPayload(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function assertGoalLifecycle(value) {
  const lifecycle = String(value || "").trim().toLowerCase();
  if (!GOAL_LIFECYCLES.has(lifecycle)) throw httpError(500, "invalid_goal_lifecycle");
  return lifecycle;
}

function canTransitionGoal(from, to) {
  const current = assertGoalLifecycle(from);
  const next = assertGoalLifecycle(to);
  if (current === next) return true;
  const transitions = {
    draft: new Set(["ready", "open", "archived", "failed"]),
    ready: new Set(["open", "paused", "archived", "failed"]),
    open: new Set(["paused", "blocked", "interrupted", "completed", "archived", "failed"]),
    paused: new Set(["ready", "open", "blocked", "archived", "failed"]),
    blocked: new Set(["ready", "open", "paused", "archived", "failed"]),
    interrupted: new Set(["ready", "open", "paused", "archived", "failed"]),
    completed: new Set(["archived"]),
    failed: new Set(["ready", "archived"]),
    archived: new Set(),
  };
  return Boolean(transitions[current] && transitions[current].has(next));
}

function assertGoalTransition(from, to) {
  if (!canTransitionGoal(from, to)) throw httpError(409, "invalid_goal_transition");
  return to;
}

function normalizeGoalPageSize(value) {
  const pageSize = Number(value || 25);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_GOAL_PAGE_SIZE) throw httpError(400, "invalid_goal_page_size");
  return pageSize;
}

function normalizeGoalClientDoc(doc = {}) {
  const data = doc.data ? doc.data() : doc;
  const id = doc.id || data.goalId;
  return {
    ...data,
    id,
    goalId: id,
    schemaVersion: Number(data.schemaVersion || GOAL_SCHEMA_VERSION),
    revision: Number.isSafeInteger(data.revision) ? data.revision : 0,
  };
}

module.exports = {
  GOAL_ACTIONS,
  GOAL_LIFECYCLES,
  GOAL_MODES,
  GOAL_SCHEMA_VERSION,
  MAX_GOAL_ANSWER_LENGTH,
  MAX_GOAL_OBJECTIVE_LENGTH,
  MAX_GOAL_PAGE_SIZE,
  assertGoalLifecycle,
  assertGoalTransition,
  canTransitionGoal,
  createOperationId,
  hashGoalPayload,
  normalizeGoalAction,
  normalizeGoalAnswer,
  normalizeGoalClientDoc,
  normalizeGoalPageSize,
  normalizeGoalPayload,
  normalizeGoalRevision,
  normalizeGoalSettings,
  normalizeGoalTitle,
  normalizeOperationId,
};
