import {normalizeSessionImageKey} from "../../config/sessionImages.js";
import {formatSessionMemory, formatSessionSizeLabel, inferSessionSize} from "../../utils/sessionResources.js";

const SUCCESS_STATUSES = new Set(["running", "ready", "success"]);
const TRANSITION_STATUSES = new Set(["queued", "provisioning", "restarting", "resizing", "stopping", "deleting", "updating", "needs_service"]);
const FAILURE_STATUSES = new Set(["provision_failed", "update_failed", "stop_failed", "delete_failed"]);
const INACTIVE_STATUSES = new Set(["stopped", "inactive", "needs_image"]);
const MARKED_RUNTIME_VERSION = "pi-web-ui-v1";
const RUNTIME_STOP_UNCERTAIN_STATUSES = new Set(["stopping", "deleting", "delete_failed"]);
const RUNTIME_FAILURE_STATUSES = new Set(["provision_failed", "update_failed", "stop_failed", "delete_failed"]);

const IMAGE_FRESHNESS_PRESENTATION = Object.freeze({
  latest: {
    label: "Latest image",
    message: "This session is running the latest runner image.",
    tone: "success",
  },
  stale: {
    label: "Stale image",
    message: "This session is running an older runner image. Restart the session to pick up the latest container.",
    tone: "warning",
  },
  unknown: {
    label: "Unknown",
    message: "Image freshness is not available for this session.",
    tone: "neutral",
  },
});

function trimSessionStatus(status) {
  return String(status || "").trim();
}

export function isMarkedRuntimeSession(session = {}) {
  return session.agentUiVersion === MARKED_RUNTIME_VERSION;
}

export function isRuntimeStopUncertain(session = {}) {
  const lifecycleStatus = trimSessionStatus(session.status).toLowerCase();
  const runtimeState = trimSessionStatus(session.agentRuntimeState).toLowerCase();
  if (lifecycleStatus === "stop_failed") return false;
  return RUNTIME_STOP_UNCERTAIN_STATUSES.has(lifecycleStatus) || runtimeState === "stopping";
}

export function getSessionRuntimeStatus(session = {}) {
  const lifecycleStatus = trimSessionStatus(session.status).toLowerCase();
  const runtimeState = trimSessionStatus(session.agentRuntimeState).toLowerCase();
  const checkpointError = trimSessionStatus(session.agentRuntimeCheckpointError);

  if (checkpointError) {
    return {
      state: "error",
      label: "Error",
      tone: "danger",
      message: "The latest persistence attempt failed. The previous successful checkpoint remains the recovery boundary.",
    };
  }
  if (RUNTIME_FAILURE_STATUSES.has(lifecycleStatus) || runtimeState === "failed") {
    return {
      state: "error",
      label: "Error",
      tone: "danger",
      message: "The server could not complete the runtime operation.",
    };
  }
  if (isRuntimeStopUncertain(session)) {
    return {
      state: "stopping",
      label: "Stopping",
      tone: "warning",
      message: "Stop is still being confirmed. Restart is disabled until the server reports the outcome.",
    };
  }
  if (lifecycleStatus === "stopped" || lifecycleStatus === "inactive" || lifecycleStatus === "needs_image" || runtimeState === "stopped") {
    return {
      state: "stopped",
      label: "Stopped",
      tone: "neutral",
      message: "The runtime is stopped. Opening restored history does not start a model turn.",
    };
  }
  if (["provisioning", "queued", "restarting", "resizing", "needs_service"].includes(lifecycleStatus) || runtimeState === "starting") {
    return {
      state: "starting",
      label: "Starting",
      tone: "warning",
      message: "The server is starting the runtime and restoring its latest checkpoint.",
    };
  }
  if (lifecycleStatus === "running" || lifecycleStatus === "ready" || runtimeState === "running") {
    return {
      state: "ready",
      label: "Ready",
      tone: "success",
      message: "The runtime is ready. Browser connection state does not control execution.",
    };
  }

  return {
    state: "error",
    label: "Error",
    tone: "danger",
    message: "The runtime status is unavailable. Check the session and try again when the server reports a state.",
  };
}

export function getSessionRuntimeError(session = {}) {
  const checkpointError = trimSessionStatus(session.agentRuntimeCheckpointError);
  if (checkpointError) return checkpointError;
  const lastError = trimSessionStatus(session.lastError);
  if (lastError) return lastError;
  if (trimSessionStatus(session.agentRuntimeRecoveryWarning) === "interrupted") {
    return "runtime_interrupted_checkpoint_recovery_required";
  }
  return "";
}

export function formatSessionCheckpointTime(value) {
  const date = value instanceof Date ? value : new Date(value || "");
  if (!Number.isFinite(date.getTime())) return "Not recorded";
  return date.toLocaleString(undefined, {dateStyle: "medium", timeStyle: "short"});
}

export function getSessionStatusLabel(statusOrSession) {
  const session = statusOrSession && typeof statusOrSession === "object" ? statusOrSession : null;
  const label = trimSessionStatus(session ? session.status : statusOrSession);
  if (session && label.toLowerCase() === "provisioning" && session.provisioningState === "queued") return "queued";
  return label || "unknown";
}

export function getSessionStatusTone(status) {
  const cleanStatus = trimSessionStatus(status).toLowerCase();
  if (SUCCESS_STATUSES.has(cleanStatus)) return "success";
  if (TRANSITION_STATUSES.has(cleanStatus)) return "warning";
  if (FAILURE_STATUSES.has(cleanStatus)) return "danger";
  if (INACTIVE_STATUSES.has(cleanStatus)) return "neutral";
  return "unknown";
}

export function isRetryableProvisioningFailure(session) {
  return session?.status === "provision_failed" && session.provisioningRetryable === true;
}

export function getSessionImageFreshness(session = {}) {
  const state = session.status === "running" &&
    Object.prototype.hasOwnProperty.call(IMAGE_FRESHNESS_PRESENTATION, session.runnerImageFreshness) ?
    session.runnerImageFreshness : "unknown";
  return {state, ...IMAGE_FRESHNESS_PRESENTATION[state]};
}

export function getSessionRunnerTags(session) {
  return normalizeSessionImageKey(session)
      .split("-")
      .map((segment) => segment.trim())
      .filter(Boolean);
}

export function getSessionResourceSummary(session) {
  const cpu = String(session?.resources?.cpu || "").trim();
  const memory = String(session?.resources?.memory || "").trim();
  const size = formatSessionSizeLabel(inferSessionSize(cpu, memory));
  return `${size} · ${cpu || "—"} vCPU / ${formatSessionMemory(memory) || "—"}`;
}
