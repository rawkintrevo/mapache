import {normalizeSessionImageKey} from "../../config/sessionImages.js";

const SUCCESS_STATUSES = new Set(["running", "ready", "success"]);
const TRANSITION_STATUSES = new Set(["provisioning", "restarting", "resizing", "stopping", "deleting", "updating", "needs_service"]);
const FAILURE_STATUSES = new Set(["provision_failed", "update_failed", "stop_failed", "delete_failed"]);
const INACTIVE_STATUSES = new Set(["stopped", "inactive", "needs_image"]);

function trimSessionStatus(status) {
  return String(status || "").trim();
}

export function getSessionStatusLabel(status) {
  const label = trimSessionStatus(status);
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

export function getSessionRunnerTags(session) {
  return normalizeSessionImageKey(session)
      .split("-")
      .map((segment) => segment.trim())
      .filter(Boolean);
}
