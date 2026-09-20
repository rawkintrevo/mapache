"use strict";

const {AUTOMATION_RUN_STATUSES} = require("./automationValidation.helpers");

const AUTOMATION_TERMINAL_STATUSES = new Set([
  "succeeded", "failed", "canceled", "interrupted", "skipped",
]);
const AUTOMATION_ACTIVE_STATUSES = new Set([
  "provisioning", "running", "stopping",
]);
const AUTOMATION_STATE_TRANSITIONS = Object.freeze({
  queued: Object.freeze(["provisioning", "canceled", "failed", "skipped"]),
  provisioning: Object.freeze(["running", "stopping", "failed", "canceled", "interrupted"]),
  running: Object.freeze(["stopping", "succeeded", "failed", "canceled", "interrupted"]),
  stopping: Object.freeze(["succeeded", "failed", "canceled", "interrupted"]),
  succeeded: Object.freeze([]),
  failed: Object.freeze([]),
  canceled: Object.freeze([]),
  interrupted: Object.freeze([]),
  skipped: Object.freeze([]),
});

function stateError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizeAutomationStatus(value, fallback = "queued") {
  const status = String(value || fallback).trim().toLowerCase();
  if (!AUTOMATION_RUN_STATUSES.includes(status)) throw stateError("invalid_automation_run_status");
  return status;
}

function isTerminalAutomationStatus(status) {
  return AUTOMATION_TERMINAL_STATUSES.has(String(status || "").trim().toLowerCase());
}

function isActiveAutomationStatus(status) {
  return AUTOMATION_ACTIVE_STATUSES.has(String(status || "").trim().toLowerCase());
}

function allowedAutomationTransitions(status) {
  const normalized = normalizeAutomationStatus(status);
  return [...AUTOMATION_STATE_TRANSITIONS[normalized]];
}

function isValidAutomationStateTransition(from, to) {
  const current = normalizeAutomationStatus(from);
  const next = normalizeAutomationStatus(to);
  return current === next || AUTOMATION_STATE_TRANSITIONS[current].includes(next);
}

function assertAutomationStateTransition(from, to) {
  if (!isValidAutomationStateTransition(from, to)) {
    throw stateError("invalid_automation_state_transition", {
      from: normalizeAutomationStatus(from),
      to: normalizeAutomationStatus(to),
    });
  }
  return true;
}

function transitionAutomationRun(run = {}, nextStatus, updates = {}) {
  const currentStatus = normalizeAutomationStatus(run.status);
  const normalizedNextStatus = normalizeAutomationStatus(nextStatus);
  assertAutomationStateTransition(currentStatus, normalizedNextStatus);
  return {
    ...run,
    ...updates,
    status: normalizedNextStatus,
  };
}

function canReleaseAutomationConcurrency(run = {}) {
  return isTerminalAutomationStatus(run.status) && run.cleanupState === "complete";
}

function shouldKeepAutomationReservation(run = {}) {
  return isActiveAutomationStatus(run.status) || run.cleanupState === "pending";
}

function normalizeRuntimeKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  return kind === "automation" ? "automation" : "main";
}

function isAutomationSession(session = {}) {
  return normalizeRuntimeKind(session.runtimeKind) === "automation";
}

function isMainSession(session = {}) {
  return !isAutomationSession(session);
}

module.exports = {
  AUTOMATION_ACTIVE_STATUSES,
  AUTOMATION_STATE_TRANSITIONS,
  AUTOMATION_TERMINAL_STATUSES,
  allowedAutomationTransitions,
  assertAutomationStateTransition,
  canReleaseAutomationConcurrency,
  isActiveAutomationStatus,
  isAutomationSession,
  isMainSession,
  isTerminalAutomationStatus,
  isValidAutomationStateTransition,
  normalizeAutomationStatus,
  normalizeRuntimeKind,
  shouldKeepAutomationReservation,
  transitionAutomationRun,
};
