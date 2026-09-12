"use strict";

const {db: defaultDb} = require("./backendContext");
const {AGENT_UI_VERSION} = require("./agentRuntime.helpers");

const QA_FAULT_HARNESS_ID = "pi-web-failure-recovery-v1";
const QA_FAULT_CASE = "pi-web-failure-recovery";
const QA_FAULTS = Object.freeze([
  "storage-publication",
  "writer-revocation",
  "uncertain-replacement",
  "no-auto-resume",
  "short-lived-access",
]);
const QA_ACCESS_TTL_MIN_MS = 1_000;
const QA_ACCESS_TTL_MAX_MS = 60_000;

function isQaFaultHarnessSession(workspace = {}, session = {}) {
  return workspace.agentUiVersion === AGENT_UI_VERSION &&
    session.agentUiVersion === AGENT_UI_VERSION &&
    session.sessionEnv?.QA_CASE === QA_FAULT_CASE &&
    session.sessionEnv?.MAPACHE_QA_FAULT_HARNESS === QA_FAULT_HARNESS_ID;
}

function qaFaultAccessTtlMs(session = {}, fallbackMs) {
  if (!session.qaFaultHarness || session.qaFaultHarness.id !== QA_FAULT_HARNESS_ID) return fallbackMs;
  const value = Number(session.qaFaultHarness.accessRenewalTtlMs);
  if (!Number.isFinite(value)) return fallbackMs;
  return Math.max(QA_ACCESS_TTL_MIN_MS, Math.min(QA_ACCESS_TTL_MAX_MS, Math.floor(value)));
}

async function consumeQaFault(sessionRef, session, fault, dependencies = {}) {
  const db = dependencies.db || defaultDb;
  if (!isQaFaultHarnessSession(dependencies.workspace || {}, session || {}) ||
      !db || typeof db.runTransaction !== "function" || !sessionRef) return false;
  if (!QA_FAULTS.includes(fault) || fault === "short-lived-access") return false;

  let consumed = false;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(sessionRef);
    if (!snapshot.exists) return;
    const current = snapshot.data() || {};
    if (!isQaFaultHarnessSession(dependencies.workspace || {}, current)) return;
    const state = current.qaFaultHarness && typeof current.qaFaultHarness === "object" ? current.qaFaultHarness : {};
    const armed = state.armed && typeof state.armed === "object" ? state.armed : {};
    const entry = armed[fault];
    if (!entry || Number(entry.remaining || 0) < 1) return;
    const nextArmed = {...armed};
    delete nextArmed[fault];
    const nextConsumed = {
      ...(state.consumed && typeof state.consumed === "object" ? state.consumed : {}),
      [fault]: {consumedAt: new Date().toISOString()},
    };
    transaction.update(sessionRef, {
      qaFaultHarness: {
        id: QA_FAULT_HARNESS_ID,
        version: 1,
        armed: nextArmed,
        consumed: nextConsumed,
        accessRenewalTtlMs: state.accessRenewalTtlMs || null,
        updatedAt: new Date().toISOString(),
      },
    });
    consumed = true;
  });
  return consumed;
}

function normalizeQaAccessTtl(value) {
  const parsed = Number(value || 3_000);
  if (!Number.isFinite(parsed)) return 3_000;
  return Math.max(QA_ACCESS_TTL_MIN_MS, Math.min(QA_ACCESS_TTL_MAX_MS, Math.floor(parsed)));
}

module.exports = {
  QA_ACCESS_TTL_MAX_MS,
  QA_ACCESS_TTL_MIN_MS,
  QA_FAULT_CASE,
  QA_FAULT_HARNESS_ID,
  QA_FAULTS,
  consumeQaFault,
  isQaFaultHarnessSession,
  normalizeQaAccessTtl,
  qaFaultAccessTtlMs,
};
