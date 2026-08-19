"use strict";

const SESSION_STATES = Object.freeze([
  "provisioning", "running", "restarting", "resizing", "stopping", "stopped",
  "deleting", "needs_image", "needs_service", "provision_failed", "update_failed",
  "stop_failed", "delete_failed",
]);

const TERMINAL_STATES = new Set(["stopped", "needs_image"]);
const FAILURE_STATES = new Set(["provision_failed", "update_failed", "stop_failed", "delete_failed"]);
const TRANSITIONS = Object.freeze({
  provisioning: new Set(["running", "restarting", "stopping", "stopped", "provision_failed", "deleting"]),
  running: new Set(["running", "restarting", "resizing", "stopping", "deleting", "update_failed"]),
  restarting: new Set(["running", "stopping", "stopped", "provision_failed", "update_failed"]),
  resizing: new Set(["running", "stopping", "stopped", "update_failed"]),
  stopping: new Set(["stopped", "stop_failed", "deleting"]),
  stopped: new Set(["provisioning", "restarting", "resizing", "deleting"]),
  deleting: new Set(["stopped", "delete_failed"]),
  needs_image: new Set(["provisioning", "deleting"]),
  needs_service: new Set(["provisioning", "restarting", "deleting"]),
  provision_failed: new Set(["provisioning", "restarting", "stopping", "deleting"]),
  update_failed: new Set(["running", "provisioning", "restarting", "resizing", "stopping", "deleting", "needs_service"]),
  stop_failed: new Set(["stopping", "deleting", "stopped"]),
  delete_failed: new Set(["deleting", "stopped"]),
});

function normalizeSessionState(status) {
  return String(status || "").trim().toLowerCase();
}

function isKnownSessionState(status) {
  return SESSION_STATES.includes(normalizeSessionState(status));
}

function isSessionTerminal(status) {
  return TERMINAL_STATES.has(normalizeSessionState(status));
}

function isSessionFailure(status) {
  return FAILURE_STATES.has(normalizeSessionState(status));
}

function canTransitionSession(currentStatus, nextStatus, options = {}) {
  const current = normalizeSessionState(currentStatus);
  const next = normalizeSessionState(nextStatus);
  if (!next || !isKnownSessionState(next)) return false;
  if (!current || current === next) return true;
  if (options.reconciliationReason) return true;
  return Boolean(TRANSITIONS[current] && TRANSITIONS[current].has(next));
}

function sessionStatusUpdate(session, nextStatus, updates = {}, options = {}) {
  const current = session && session.status;
  if (!canTransitionSession(current, nextStatus, options)) {
    const error = new Error(`invalid_session_transition:${normalizeSessionState(current)}->${normalizeSessionState(nextStatus)}`);
    error.code = "invalid_session_transition";
    throw error;
  }
  return {...updates, status: normalizeSessionState(nextStatus)};
}

module.exports = {
  SESSION_STATES,
  canTransitionSession,
  isKnownSessionState,
  isSessionFailure,
  isSessionTerminal,
  normalizeSessionState,
  sessionStatusUpdate,
};
