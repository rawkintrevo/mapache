"use strict";

function recordSinkDeliveryAttempt(run = {}, sinkKey, outcome = {}) {
  const key = String(sinkKey || "").trim();
  if (!key || !run.sinkDelivery?.[key]) throw deliveryError("sink_not_declared");
  const current = run.sinkDelivery[key];
  const success = outcome.state === "delivered";
  const next = {
    ...run,
    sinkDelivery: {
      ...run.sinkDelivery,
      [key]: {
        ...current,
        state: success ? "delivered" : "failed",
        attempts: Number(current.attempts || 0) + 1,
        lastError: success ? null : safeError(outcome.error),
        deliveredAt: success ? (outcome.deliveredAt || null) : (current.deliveredAt || null),
      },
    },
  };
  return next;
}

function canRetrySinkDelivery(run = {}, sinkKey) {
  const state = run.sinkDelivery?.[String(sinkKey || "").trim()];
  return Boolean(state && ["pending", "failed"].includes(state.state) &&
    !["unknown", "interrupted"].includes(String(run.outcome || run.status || "").toLowerCase()));
}

function safeError(value) {
  return String(value || "sink_delivery_failed").slice(0, 256);
}

function deliveryError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {canRetrySinkDelivery, recordSinkDeliveryAttempt};
