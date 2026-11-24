"use strict";

const {cleanName} = require("./backendUtils.helpers");

const RUNNER_BUSY_PATTERNS = [
  /no available instance/i,
  /runner.*unavailable/i,
  /request was aborted/i,
];

function parseRunnerResponseBody(rawBody) {
  const text = typeof rawBody === "string" ? rawBody.trim() : "";
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function classifyRunnerResponseError({status, data, rawBody, fallbackError = "runner_request_failed"}) {
  const rawText = typeof rawBody === "string" ? rawBody.trim() : "";
  const explicitError = cleanName(data && data.error ? data.error : "");
  const detail = [
    explicitError,
    data && typeof data.message === "string" ? data.message : "",
    rawText,
  ].filter(Boolean).join("\n");

  if (status === 429 || RUNNER_BUSY_PATTERNS.some((pattern) => pattern.test(detail))) {
    return "runner_busy_or_unavailable";
  }

  return explicitError || cleanName(fallbackError) || "runner_request_failed";
}

function runnerRequestUrl(serviceUrl, routePath, accessToken = "") {
  const baseUrl = `${String(serviceUrl || "").replace(/\/+$/, "")}${routePath}`;
  const token = String(accessToken || "").trim();
  return token ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}mapache_access=${encodeURIComponent(token)}` : baseUrl;
}

module.exports = {
  classifyRunnerResponseError,
  parseRunnerResponseBody,
  runnerRequestUrl,
};
