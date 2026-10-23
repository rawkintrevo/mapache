"use strict";

const ERROR_DESCRIPTORS = Object.freeze({
  workspace_request_canceled: {
    message: "The target workspace canceled this request.",
    action: "Submit a new request if the work is still needed.",
  },
  workspace_request_model_unavailable: {
    message: "The requested model is not available in the target workspace.",
    action: "Discover the target models and choose an available model.",
  },
  workspace_request_provider_auth_required: {
    message: "The target workspace cannot authenticate to the requested model provider.",
    action: "Sign in to the provider in the target workspace, then retry.",
  },
  workspace_request_model_auth_incompatible: {
    message: "The requested model is not compatible with the target provider account.",
    action: "Choose an available model supported by the target account or update its provider authentication.",
  },
  workspace_request_model_ambiguous: {
    message: "The model name matched more than one target model.",
    action: "Use the providerId and modelId returned by model discovery.",
  },
  workspace_request_model_discovery_unavailable: {
    message: "The target workspace model catalog is temporarily unavailable.",
    action: "Retry discovery when the target workspace runtime is ready.",
  },
  workspace_request_interaction_required: {
    message: "The target workspace needs an interactive action before this request can finish.",
    action: "Open the target workspace, complete the requested action, and retry.",
  },
  shared_runtime_dispatch_rejected: {
    message: "The target workspace rejected this request before it started.",
    action: "Check the target runtime and request model, then retry.",
  },
  shared_runtime_request_failed: {
    message: "The target workspace could not complete this request.",
    action: "Check the target runtime and model credentials, then retry.",
  },
  shared_runtime_status_unavailable: {
    message: "The target workspace runtime stopped responding while this request was running.",
    action: "Check the target runtime and retry the request.",
  },
  shared_runtime_dispatch_ambiguous: {
    message: "The request outcome could not be confirmed after dispatch.",
    action: "Check the target workspace before submitting another request with the same idempotency key.",
  },
});

const PRIVATE_TEXT = /(api[_-]?key|access[_-]?token|bearer\s+[a-z0-9._-]+|password|secret|credential|private[_-]?key|https?:\/\/\S+)/gi;

function classifyWorkspaceRequestFailure(value, fallback = "shared_runtime_request_failed") {
  const text = collectErrorText(value).toLowerCase();
  if (value?.status === "canceled" || /\bcancel(?:ed|led)\b/.test(text)) return "workspace_request_canceled";
  if (/interaction|required action|needs input|approval/.test(text)) return "workspace_request_interaction_required";
  if (/model.*(?:not supported|unsupported).*account|codex.*chatgpt|chatgpt.*account/.test(text)) {
    return "workspace_request_model_auth_incompatible";
  }
  if (/model.*unavailable|unknown model|model.*not found|invalid model|model.*not supported|unsupported model/.test(text)) {
    return "workspace_request_model_unavailable";
  }
  if (/auth|unauthorized|forbidden|api key|credential|login/.test(text)) return "workspace_request_provider_auth_required";
  if (/discovery|catalog|models/.test(text) && /unavailable|failed|timeout/.test(text)) return "workspace_request_model_discovery_unavailable";
  if (/dispatch.*reject|rejected/.test(text)) return "shared_runtime_dispatch_rejected";
  return isSafeErrorCode(fallback) ? fallback : "shared_runtime_request_failed";
}

function errorDescriptor(code, detail) {
  const normalized = isSafeErrorCode(code) ? code : "shared_runtime_request_failed";
  const known = ERROR_DESCRIPTORS[normalized] || ERROR_DESCRIPTORS.shared_runtime_request_failed;
  const message = safeErrorText(detail) || known.message;
  return {code: normalized, message, action: known.action};
}

function safeErrorText(value) {
  const text = typeof value === "string" ? value : value?.message || value?.error || "";
  if (!text) return null;
  const safe = String(text).replace(PRIVATE_TEXT, "[redacted]").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return safe ? safe.slice(0, 240) : null;
}

function collectErrorText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return [value.error, value.message, value.state?.finalError, value.state?.error, value.finalError]
      .filter(Boolean).map(String).join(" ");
}

function isSafeErrorCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{2,127}$/.test(value);
}

module.exports = {
  classifyWorkspaceRequestFailure,
  errorDescriptor,
  safeErrorText,
};
