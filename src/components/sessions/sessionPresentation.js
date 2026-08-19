import {normalizeSessionImageKey} from "../../config/sessionImages.js";
import {formatSessionMemory, formatSessionSizeLabel, inferSessionSize} from "../../utils/sessionResources.js";

const SUCCESS_STATUSES = new Set(["running", "ready", "success"]);
const TRANSITION_STATUSES = new Set(["queued", "provisioning", "restarting", "resizing", "stopping", "deleting", "updating", "needs_service"]);
const FAILURE_STATUSES = new Set(["provision_failed", "update_failed", "stop_failed", "delete_failed"]);
const INACTIVE_STATUSES = new Set(["stopped", "inactive", "needs_image"]);

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
