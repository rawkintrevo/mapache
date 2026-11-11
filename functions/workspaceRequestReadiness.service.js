"use strict";

const {httpError} = require("./backendUtils.helpers");

const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const TERMINAL_FAILURE_STATES = new Set([
  "stopped", "needs_image", "deleting", "provision_failed", "update_failed", "stop_failed", "delete_failed",
]);

/**
 * Wait for one already-selected main session to become application-ready.
 *
 * The caller is responsible for selecting/creating/restarting the canonical
 * session once. This helper only re-reads that session, so a slow startup
 * cannot cause a second Cloud Run service or lifecycle operation.
 */
async function waitForWorkspaceRuntimeReady(options = {}) {
  const workspaceId = String(options.workspaceId || "").trim();
  const sessionId = String(options.session?.id || "").trim();
  const now = options.now || (() => Date.now());
  const delay = options.delay || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const logger = options.logger || console;
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
  const pollIntervalMs = positiveNumber(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const isReady = options.isReady || (() => false);
  const readSession = options.readSession;
  if (!workspaceId || !sessionId || typeof readSession !== "function") {
    throw httpError(503, "workspace_request_runtime_start_failed");
  }

  const startedAt = Number(now()) || 0;
  const deadline = startedAt + timeoutMs;
  let current = options.session || null;
  let previousStatus = "";
  let pollCount = 0;

  while (true) {
    if (isReady(current)) {
      return {session: current, elapsedMs: Math.max(0, (Number(now()) || startedAt) - startedAt), pollCount};
    }

    const status = normalize(current?.status);
    if (status !== previousStatus) {
      previousStatus = status;
      logger.info?.("workspace request runtime readiness", {
        workspaceId,
        sessionId,
        status: status || "missing",
        elapsedMs: Math.max(0, (Number(now()) || startedAt) - startedAt),
      });
    }
    if (TERMINAL_FAILURE_STATES.has(status)) {
      throw httpError(503, "workspace_request_runtime_start_failed");
    }

    const remaining = deadline - (Number(now()) || startedAt);
    if (remaining <= 0) {
      logger.warn?.("workspace request runtime readiness timed out", {
        workspaceId,
        sessionId,
        status: status || "missing",
        elapsedMs: Math.max(0, (Number(now()) || startedAt) - startedAt),
        pollCount,
      });
      throw httpError(504, "workspace_request_runtime_start_timeout");
    }

    await delay(Math.min(pollIntervalMs, remaining));
    current = await readSession(workspaceId, sessionId);
    pollCount += 1;
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

module.exports = {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  waitForWorkspaceRuntimeReady,
};
