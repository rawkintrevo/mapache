"use strict";

const {createHash} = require("node:crypto");

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const GATEWAY_HOST = /^[a-z0-9][a-z0-9.-]{0,252}\.run\.app$/;

function createVmBackupRuntimeEvidenceService({db, fetchImpl = fetch, now = Date.now} = {}) {
  if (!db || typeof fetchImpl !== "function") throw new Error("vm_backup_runtime_evidence_dependencies_required");

  return {capture};

  async function capture({workspaceId, ownerUid, descriptor} = {}) {
    const observedNow = now();
    const runtimeSnapshot = await db.collection("vmRuntimes_v2").doc(workspaceId).get();
    const runtime = runtimeSnapshot.data() || {};
    if (!runtimeSnapshot.exists || runtime.ownerUid !== ownerUid || runtime.generation !== descriptor?.generation) {
      throw evidenceError("vm_backup_source_runtime_identity_mismatch");
    }
    if (runtime.state !== "active" || runtime.lifecycleEnabled !== true || !runtime.currentSessionId ||
        !(runtime.leaseExpiresAt > observedNow) || !GATEWAY_HOST.test(String(runtime.gatewayHost || ""))) {
      return null;
    }
    const credentialsSnapshot = await db.collection("vmRuntimeCredentials_v2").doc(runtime.currentSessionId).get();
    const credentials = credentialsSnapshot.data() || {};
    if (!credentialsSnapshot.exists || credentials.ownerUid !== ownerUid || !credentials.shutdownToken) {
      throw evidenceError("vm_backup_source_runtime_credentials_missing");
    }
    const headers = {"x-shutdown-token": String(credentials.shutdownToken)};
    const startedAtMs = now();
    const health = await requestJson(`https://${runtime.gatewayHost}/runner/health`, headers, "health");
    const healthAtMs = now();
    const digest = await requestJson(`https://${runtime.gatewayHost}/runner/recovery-digest`, headers, "digest");
    const digestAtMs = now();
    if (health.workspaceId !== workspaceId || health.sessionId !== runtime.currentSessionId ||
        health.agentRuntime?.ready !== true || health.ok !== true) {
      throw evidenceError("vm_backup_source_runtime_not_ready");
    }
    if (digest.workspaceId !== workspaceId || digest.sessionId !== runtime.currentSessionId ||
        digest.ok !== true || !DIGEST.test(String(digest.fileDigest || "")) ||
        !Number.isSafeInteger(digest.entryCount) || !Number.isSafeInteger(digest.byteCount)) {
      throw evidenceError("vm_backup_source_digest_invalid");
    }
    return {
      version: 1,
      capturedAt: new Date(digestAtMs).toISOString(),
      runtimeReady: true,
      fileDigest: digest.fileDigest,
      runtimeStateDigest: runtimeStateDigest(health),
      entryCount: digest.entryCount,
      byteCount: digest.byteCount,
      timingsMs: {health: Math.max(0, healthAtMs - startedAtMs), digest: Math.max(0, digestAtMs - healthAtMs),
        total: Math.max(0, digestAtMs - startedAtMs)},
    };

    async function requestJson(url, headers, label) {
      let response;
      try {
        response = await fetchImpl(url, {method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(30_000)});
      } catch {
        throw evidenceError(`vm_backup_source_${label}_unavailable`);
      }
      if (!response.ok) {
        await response.body?.cancel?.();
        throw evidenceError(`vm_backup_source_${label}_unavailable`);
      }
      try {
        return await response.json();
      } catch {
        throw evidenceError(`vm_backup_source_${label}_invalid`);
      }
    }
  }
}

function runtimeStateDigest(health) {
  const safe = {
    ok: health?.ok === true,
    workspaceId: String(health?.workspaceId || ""),
    sessionId: String(health?.sessionId || ""),
    agentRuntime: {
      ready: health?.agentRuntime?.ready === true,
      state: String(health?.agentRuntime?.state || ""),
      health: {
        ready: health?.agentRuntime?.health?.ready === true,
        engine: String(health?.agentRuntime?.health?.engine || ""),
        packageVersion: String(health?.agentRuntime?.health?.build?.packageVersion || ""),
        upstreamCommit: String(health?.agentRuntime?.health?.build?.upstreamCommit || ""),
      },
    },
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(safe)).digest("hex")}`;
}

function evidenceError(code) {
  const error = new Error(code);
  error.code = code;
  error.publicMessage = code;
  return error;
}

module.exports = {createVmBackupRuntimeEvidenceService, runtimeStateDigest};
