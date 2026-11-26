"use strict";

const crypto = require("node:crypto");

const MAX_LABEL_VALUE_LENGTH = 63;

function normalizeComputeEngineLabelValue(value) {
  const raw = String(value || "").trim();
  let normalized = raw.toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/^-+|-+$/g, "");
  if (!normalized) normalized = "unknown";
  if (!/^[a-z]/.test(normalized)) normalized = `m-${normalized}`;
  if (normalized.length <= MAX_LABEL_VALUE_LENGTH) return normalized;

  const suffix = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return `${normalized.slice(0, MAX_LABEL_VALUE_LENGTH - suffix.length - 1)}-${suffix}`;
}

module.exports = {MAX_LABEL_VALUE_LENGTH, normalizeComputeEngineLabelValue};
