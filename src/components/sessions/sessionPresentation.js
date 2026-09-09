import {normalizeSessionImageKey} from "../../config/sessionImages.js";
import {formatSessionMemory, formatSessionSizeLabel, inferSessionSize} from "../../utils/sessionResources.js";

const SUCCESS_STATUSES = new Set(["running", "ready", "success"]);
const TRANSITION_STATUSES = new Set(["queued", "provisioning", "restarting", "resizing", "stopping", "deleting", "updating", "needs_service"]);
const FAILURE_STATUSES = new Set(["provision_failed", "update_failed", "stop_failed", "delete_failed"]);
const INACTIVE_STATUSES = new Set(["stopped", "inactive", "needs_image"]);

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
