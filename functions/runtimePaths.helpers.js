"use strict";

const DIRECTORY_MARKER_FILE = ".mapache-directory";
const LEGACY_DIRECTORY_MARKER_FILE = ".mapahce-directory";
const DIRECTORY_MARKER_FILES = [
  DIRECTORY_MARKER_FILE,
  LEGACY_DIRECTORY_MARKER_FILE,
];

const INTERNAL_STORAGE_DIR = ".mapache-internal";
const LEGACY_INTERNAL_STORAGE_DIR = ".mapahce-internal";
const INTERNAL_STORAGE_DIRS = [
  INTERNAL_STORAGE_DIR,
  LEGACY_INTERNAL_STORAGE_DIR,
];

const AUTOMATION_RUNTIME_KIND = "automation";
const MAIN_RUNTIME_KIND = "main";
const AUTOMATION_SESSION_PREFIX = "auto-";

function normalizeRuntimeKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  return kind === AUTOMATION_RUNTIME_KIND ? AUTOMATION_RUNTIME_KIND : MAIN_RUNTIME_KIND;
}

function isAutomationRuntime(value = {}) {
  return normalizeRuntimeKind(value.runtimeKind || value) === AUTOMATION_RUNTIME_KIND;
}

function isMainRuntime(value = {}) {
  return normalizeRuntimeKind(value.runtimeKind || value) === MAIN_RUNTIME_KIND;
}

function automationSessionId(runId) {
  const normalizedRunId = String(runId || "").trim();
  if (!normalizedRunId || /[^A-Za-z0-9_-]/.test(normalizedRunId)) {
    throw new Error("invalid_automation_run_id");
  }
  return `${AUTOMATION_SESSION_PREFIX}${normalizedRunId}`;
}

function automationRunIdFromSessionId(sessionId) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId.startsWith(AUTOMATION_SESSION_PREFIX)) return "";
  const runId = normalizedSessionId.slice(AUTOMATION_SESSION_PREFIX.length);
  return runId && !/[^A-Za-z0-9_-]/.test(runId) ? runId : "";
}

function workspaceAutomationsPath(workspaceId) {
  const id = String(workspaceId || "").trim();
  if (!id) throw new Error("invalid_workspace_id");
  return `workspaces/${id}/automations`;
}

function workspaceAutomationPath(workspaceId, automationId) {
  const id = String(automationId || "").trim();
  if (!id) throw new Error("invalid_automation_id");
  return `${workspaceAutomationsPath(workspaceId)}/${id}`;
}

function automationRunsPath() {
  return "automationRuns";
}

function automationRunPath(runId) {
  const id = String(runId || "").trim();
  if (!id) throw new Error("invalid_automation_run_id");
  return `${automationRunsPath()}/${id}`;
}

function isDirectoryMarkerFileName(value) {
  return DIRECTORY_MARKER_FILES.includes(String(value || ""));
}

function isInternalStorageDirName(value) {
  return INTERNAL_STORAGE_DIRS.includes(String(value || ""));
}

function canonicalizeInternalStoragePath(value) {
  return String(value || "").replace(
      /(^|\/)\.mapahce-internal(?=\/|$)/g,
      `$1${INTERNAL_STORAGE_DIR}`,
  );
}

module.exports = {
  AUTOMATION_RUNTIME_KIND,
  AUTOMATION_SESSION_PREFIX,
  DIRECTORY_MARKER_FILE,
  DIRECTORY_MARKER_FILES,
  INTERNAL_STORAGE_DIR,
  INTERNAL_STORAGE_DIRS,
  LEGACY_DIRECTORY_MARKER_FILE,
  LEGACY_INTERNAL_STORAGE_DIR,
  MAIN_RUNTIME_KIND,
  automationRunIdFromSessionId,
  automationRunPath,
  automationRunsPath,
  automationSessionId,
  canonicalizeInternalStoragePath,
  isDirectoryMarkerFileName,
  isInternalStorageDirName,
  isAutomationRuntime,
  isMainRuntime,
  normalizeRuntimeKind,
  workspaceAutomationPath,
  workspaceAutomationsPath,
};
