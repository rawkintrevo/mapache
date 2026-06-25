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

export function getSessionImageFreshness(session) {
  const status = String(session?.imageFreshness?.status || "").trim().toLowerCase();
  if (status === "latest") {
    return {
      status: "latest",
      label: "Latest image",
      tone: "success",
      tooltip: "This session is running the latest runner image.",
    };
  }
  if (status === "stale") {
    return {
      status: "stale",
      label: "Stale image",
      tone: "warning",
      tooltip: "This session is running an older runner image. Restart the session to pick up the latest container.",
    };
  }
  return {
    status: "unknown",
    label: "Image freshness unknown",
    tone: "neutral",
    tooltip: "Image freshness is not available for this session.",
  };
}

export function isSessionRunningStaleImage(session) {
  return String(session?.status || "").trim().toLowerCase() === "running" &&
    getSessionImageFreshness(session).status === "stale";
}
