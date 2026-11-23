"use strict";

const {createHash, timingSafeEqual} = require("node:crypto");
const {httpError} = require("./backendUtils.helpers");
const {normalizePiAuthEntries, normalizePiAuthProviders} = require("./agentAuth.service");

const COLLECTION = "vmRuntimes_v2";
const LEASE_MS = 45000;
const TIME_FIELDS = new Set(["runtimeStartedAt", "lastActivityAt", "lastConnectedAt", "lastDisconnectedAt", "shutdownRequestedAt"]);

function createVmRuntimeControlService({db, admin, now = Date.now}) {
  return async function handle(req) {
    if (req.method !== "POST") throw httpError(405, "method_not_allowed");
    const body = req.body || {};
    if (Buffer.byteLength(JSON.stringify(body)) > 65536) throw httpError(413, "request_too_large");
    const workspaceId = identifier(body.workspaceId);
    const sessionId = identifier(body.sessionId);
    const bootId = identifier(body.bootId);
    const generation = Number(body.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) throw httpError(400, "invalid_generation");
    const token = String(req.get?.("authorization") || "").replace(/^Bearer /, "");
    const workspaceRef = db.collection(COLLECTION).doc(workspaceId);
    const sessionRef = workspaceRef.collection("sessions").doc(sessionId);
    return db.runTransaction(async (tx) => {
      const [ws, ss] = await Promise.all([tx.get(workspaceRef), tx.get(sessionRef)]);
      const workspace = ws.data() || {};
      const session = ss.data() || {};
      if (!ws.exists || !ss.exists || !validToken(token, session.controlTokenHash)) throw httpError(404, "not_found");
      if (!workspace.ownerUid || session.ownerUid !== workspace.ownerUid || workspace.currentSessionId !== sessionId ||
          workspace.generation !== generation || session.generation !== generation ||
          workspace.backend !== "compute-engine") throw httpError(409, "vm_generation_mismatch");
      if (!["reserved", "active", "stopping"].includes(workspace.state) ||
          !["reserved", "active", "stopping"].includes(session.state)) throw httpError(409, "vm_session_unavailable");
      const time = now();
      const current = session.bootId === bootId && workspace.bootId === bootId &&
        session.leaseExpiresAt > time && workspace.leaseExpiresAt > time;
      const timestamp = () => admin.firestore.FieldValue.serverTimestamp();
      if (body.action === "lease.acquire") {
        if (workspace.state === "stopping" || session.state === "stopping") throw httpError(409, "vm_boot_not_reserved");
        if (session.bootId || workspace.bootId) {
          if (!current) throw httpError(409, "vm_boot_conflict");
        } else if (workspace.state !== "reserved" || session.state !== "reserved") {
          throw httpError(409, "vm_boot_not_reserved");
        }
        const update = {bootId, state: "active", leaseExpiresAt: time + LEASE_MS, heartbeatAt: timestamp()};
        tx.update(workspaceRef, update);
        tx.update(sessionRef, update);
        return {ok: true, leaseExpiresAt: update.leaseExpiresAt};
      }
      if (!current) throw httpError(409, "vm_writer_authority_lost");
      if (body.action === "lease.check") return {ok: true, leaseExpiresAt: session.leaseExpiresAt};
      if (body.action === "lease.renew") {
        const update = {leaseExpiresAt: time + LEASE_MS, heartbeatAt: timestamp()};
        tx.update(workspaceRef, update);
        tx.update(sessionRef, update);
        return {ok: true, leaseExpiresAt: update.leaseExpiresAt};
      }
      if (body.action === "lease.release") {
        const update = {state: "released", leaseExpiresAt: 0, releasedAt: timestamp()};
        tx.update(workspaceRef, update);
        tx.update(sessionRef, update);
        return {ok: true};
      }
      if (body.action === "models.get") return {models: session.piScopedModels || []};
      if (body.action === "models.set") {
        const models = body.payload?.models;
        if (!Array.isArray(models) || models.length > 100 || models.some((x) => typeof x !== "string" || x.length > 256)) {
          throw httpError(400, "invalid_models");
        }
        tx.update(sessionRef, {piScopedModels: [...new Set(models)], updatedAt: timestamp()});
        return {ok: true};
      }
      if (body.action === "auth.get") {
        const snap = await tx.get(db.collection("users").doc(workspace.ownerUid).collection("private").doc("agentAuth"));
        const auth = snap.data() || {};
        const providers = normalizePiAuthProviders(auth.providers);
        const entries = normalizePiAuthEntries(auth.entries, providers);
        const selection = session.authSelection || {harness: "pi", providers: {}};
        const selected = {};
        for (const [provider, entryId] of Object.entries(selection.providers || {})) {
          if (Object.hasOwn(entries, entryId) && entries[entryId].providerKey === provider) selected[entryId] = entries[entryId];
        }
        return {selection, data: {providers: {}, entries: selected}};
      }
      if (body.action === "activity") {
        const update = {};
        for (const [key, value] of Object.entries(body.payload || {})) {
          if (TIME_FIELDS.has(key)) update[key] = timestamp();
          else if (key === "activeSocketCount" && Number.isSafeInteger(value) && value >= 0 && value <= 10000) update[key] = value;
          else throw httpError(400, "invalid_activity_field");
        }
        if (Object.keys(update).length) tx.update(sessionRef, update);
        return {ok: true};
      }
      if (body.action === "history") {
        const {stream, data} = body.payload || {};
        if (!["stdout", "stderr", "stdin", "system", "shell", "shell_stdout"].includes(stream) || typeof data !== "string" || data.length > 4096) throw httpError(400, "invalid_history");
        tx.set(sessionRef.collection("terminalHistory").doc(), {stream, data, createdAt: timestamp()});
        return {ok: true};
      }
      if (body.action === "failure") {
        const message = String(body.payload?.message || "vm_runner_failed").slice(0, 512);
        tx.update(sessionRef, {runtimeState: "failed", lastError: message, runtimeFailedAt: timestamp()});
        return {ok: true};
      }
      throw httpError(400, "unknown_vm_control_action");
    });
  };
}

function identifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw httpError(400, "invalid_identity");
  return value;
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function validToken(token, expected) {
  if (token.length < 32 || token.length > 256 || !/^[a-f0-9]{64}$/.test(expected || "")) return false;
  return timingSafeEqual(Buffer.from(tokenHash(token), "hex"), Buffer.from(expected, "hex"));
}

module.exports = {COLLECTION, LEASE_MS, createVmRuntimeControlService, tokenHash};
