"use strict";

const crypto = require("node:crypto");
const {httpError} = require("./backendUtils.helpers");
const {checkOwned, publicWorkspace} = require("./vmRead.service");
const {hasVmMigrationFence} = require("./vmMigrationFence.helpers");
const {
  getNextRuntimeScheduleStart,
  getRuntimeScheduleState,
  normalizeRuntimePolicy,
} = require("./runtimeSchedule.helpers");

const MAX_SCAN = 100;
const LEASE_MS = 10 * 60 * 1000;

function policyFor(workspace = {}) {
  const stored = workspace.runtimePolicy;
  if (!stored) return {mode: "idle", schedule: null};
  try {
    return normalizeRuntimePolicy(stored);
  } catch {
    throw httpError(409, "vm_runtime_policy_invalid");
  }
}

function safeErrorCode(error, fallback) {
  const candidate = String(error?.publicMessage || error?.code || error?.message || "").trim();
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(candidate) ? candidate : fallback;
}

function asDate(value) {
  const date = value instanceof Date ? value : value && typeof value.toDate === "function" ? value.toDate() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_runtime_schedule_time");
  return date;
}

function scheduleStatus(workspace, state) {
  if (state.active && workspace.runtimeScheduleManualPauseWindowKey === state.windowKey) return "manually_paused";
  return state.active ? "open" : "closed";
}

function nextEvent(event, timezone) {
  return {action: event.action, at: event.at, windowKey: event.windowKey, timezone};
}

function response(workspaceId, workspace, time) {
  const workspaceWithPolicy = {...workspace, runtimePolicy: policyFor(workspace)};
  return {
    workspace: publicWorkspace(workspaceId, workspaceWithPolicy, time),
    runtimePolicy: workspaceWithPolicy.runtimePolicy,
    runtimeScheduleError: workspace.runtimeScheduleError || null,
    runtimeScheduleManualPauseWindowKey: workspace.runtimeScheduleManualPauseWindowKey || null,
    runtimeScheduleNextEvent: workspace.runtimeScheduleNextEvent || null,
    runtimeScheduleStatus: workspace.runtimeScheduleStatus || null,
  };
}

function createVmRuntimePolicyService({db, lifecycle, now = Date.now} = {}) {
  if (!db) throw new Error("vm_runtime_policy_db_required");

  async function getWorkspaceRuntimePolicy({workspaceId, ownerUid}) {
    const ref = db.collection("vmRuntimes_v2").doc(workspaceId);
    const snap = await ref.get();
    const workspace = snap.data();
    checkOwned(workspace, ownerUid);
    return response(workspaceId, workspace, now());
  }

  async function updateWorkspaceRuntimePolicy({workspaceId, ownerUid, patch}) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch) ||
        Object.keys(patch).some(key => !["expectedGeneration", "mode", "schedule"].includes(key)) ||
        !Number.isSafeInteger(patch.expectedGeneration) || patch.expectedGeneration < 1 ||
        typeof patch.mode !== "string") {
      throw httpError(400, "invalid_runtime_policy");
    }
    const ref = db.collection("vmRuntimes_v2").doc(workspaceId);
    await db.runTransaction(async tx => {
      const workspace = (await tx.get(ref)).data();
      checkOwned(workspace, ownerUid);
      if (workspace.generation !== patch.expectedGeneration) throw httpError(409, "vm_generation_mismatch");
      if (workspace.activeOperationId) throw httpError(409, "vm_operation_in_progress");
      if (await hasVmMigrationFence(tx, db, workspaceId)) throw httpError(409, "workspace_vm_migration_active");
      const policy = normalizeRuntimePolicy(patch, policyFor(workspace));
      const currentRevision = Number.isSafeInteger(workspace.runtimePolicyRevision) ? workspace.runtimePolicyRevision : 0;
      const sessionRef = workspace.currentSessionId ? ref.collection("sessions").doc(workspace.currentSessionId) : null;
      const session = sessionRef ? (await tx.get(sessionRef)).data() : null;
      if (!session || session.ownerUid !== ownerUid || session.generation !== workspace.generation) {
        throw httpError(409, "vm_session_mismatch");
      }
      tx.update(ref, {
        runtimePolicy: policy,
        runtimePolicyRevision: currentRevision + 1,
        runtimeScheduleStatus: null,
        runtimeScheduleNextEvent: null,
        runtimeScheduleError: null,
        runtimeScheduleManualPauseWindowKey: null,
        runtimeScheduleLease: null,
        updatedAtMs: now(),
      });
      tx.update(sessionRef, {longRunning: policy.mode === "keep-running"});
    });

    const updated = await ref.get();
    const workspace = updated.data();
    if (policyFor(workspace).mode === "scheduled" && lifecycle) {
      await reconcileVmRuntimePolicy(workspaceId, asDate(now()), {db, lifecycle, now});
    }
    return response(workspaceId, (await ref.get()).data(), now());
  }

  async function reconcileVmRuntimePolicy(workspaceId, nowValue = new Date(), dependencies = {}) {
    const firestore = dependencies.db || db;
    const runtimeLifecycle = dependencies.lifecycle || lifecycle;
    if (!runtimeLifecycle || typeof runtimeLifecycle.request !== "function") {
      throw new Error("vm_runtime_policy_lifecycle_required");
    }
    const nowDate = asDate(nowValue);
    const ref = firestore.collection("vmRuntimes_v2").doc(workspaceId);
    const claim = await claimWorkspace(ref, workspaceId, nowDate, firestore);
    if (!claim) return {workspaceId, skipped: true, reason: "not_scheduled_or_unavailable"};
    if (claim.fenced) return {workspaceId, skipped: true, reason: "workspace_vm_migration_active"};
    if (claim.busy) return {workspaceId, skipped: true, reason: "reconciliation_in_progress"};

    let result;
    try {
      const current = (await ref.get()).data();
      if (!current || current.runtimePolicyRevision !== claim.revision || policyFor(current).mode !== "scheduled") {
        result = {workspaceId, skipped: true, stale: true, reason: "policy_changed"};
      } else {
        const policy = policyFor(current);
        const state = getRuntimeScheduleState(policy.schedule, nowDate);
        const manuallyPaused = state.active && current.runtimeScheduleManualPauseWindowKey === state.windowKey;
        const nextScheduleEvent = manuallyPaused ? getNextRuntimeScheduleStart(policy.schedule, nowDate) : state.nextEvent;
        const desiredAction = state.active && !manuallyPaused ? "start" : !state.active ? "pause" : null;
        if (!desiredAction) {
          result = {workspaceId, action: manuallyPaused ? "manually_paused" : "already_running", failed: false};
        } else if (desiredAction === "start" && current.state === "active") {
          result = {workspaceId, action: "already_running", failed: false};
        } else if (desiredAction === "pause" && current.state === "stopped") {
          result = {workspaceId, action: "outside_window", failed: false};
        } else if (current.activeOperationId || !["active", "stopped"].includes(current.state)) {
          result = {workspaceId, action: "lifecycle_in_progress", failed: false};
        } else {
          const requestId = `runtime-schedule-${desiredAction}-${state.windowKey}`;
          const request = await runtimeLifecycle.request({workspaceId, ownerUid: current.ownerUid,
            action: desiredAction, expectedGeneration: current.generation, requestId, requireApiAdmission: true});
          if (request?.status === "failed" && typeof runtimeLifecycle.retry === "function") {
            await runtimeLifecycle.retry({workspaceId, ownerUid: current.ownerUid, operationId: request.operationId});
          }
          result = {workspaceId, action: desiredAction === "start" ? "start_requested" : "pause_requested", failed: false,
            operationId: request?.operationId || null};
        }
        await completeClaim(claim, {
          runtimeScheduleStatus: scheduleStatus(current, state),
          runtimeScheduleNextEvent: nextEvent(nextScheduleEvent, policy.schedule.timezone),
          runtimeScheduleError: null,
          runtimeScheduleLastAction: result.action,
          runtimeScheduleReconciledAt: nowDate,
        }, firestore);
        return result;
      }
    } catch (error) {
      result = {workspaceId, action: "failed", failed: true, errorCode: safeErrorCode(error, "runtime_schedule_reconcile_failed")};
      await completeClaim(claim, {
        runtimeScheduleError: {action: error?.action || "reconcile", code: result.errorCode, at: nowDate},
        runtimeScheduleLastAction: result.action,
        runtimeScheduleReconciledAt: nowDate,
      }, firestore);
      return result;
    }
    await completeClaim(claim, {}, firestore);
    return result;
  }

  async function reconcileScheduledVmWorkspaces({max = MAX_SCAN} = {}) {
    const snapshot = await db.collection("vmRuntimes_v2").limit(max).get();
    const docs = Array.isArray(snapshot.docs) ? snapshot.docs : [];
    const results = await Promise.allSettled(docs.map(doc => Promise.resolve().then(() => {
      const workspace = doc.data() || {};
      return policyFor(workspace).mode === "scheduled" ? reconcileVmRuntimePolicy(doc.id, new Date(now()), {db, lifecycle}) :
        Promise.resolve({workspaceId: doc.id, skipped: true, reason: "not_scheduled"});
    })));
    return {scanned: docs.length,
      requested: results.filter(result => result.status === "fulfilled" && ["start_requested", "pause_requested"].includes(result.value.action)).length,
      skipped: results.filter(result => result.status === "fulfilled" && result.value.skipped).length,
      failed: results.filter(result => result.status === "rejected" || result.value?.failed).length,
      results};
  }

  return {getWorkspaceRuntimePolicy, updateWorkspaceRuntimePolicy, reconcileVmRuntimePolicy, reconcileScheduledVmWorkspaces};
}

async function claimWorkspace(ref, workspaceId, now, firestore) {
  const token = crypto.randomUUID();
  return firestore.runTransaction(async tx => {
    const workspace = (await tx.get(ref)).data();
    if (!workspace) return null;
    const policy = policyFor(workspace);
    if (policy.mode !== "scheduled" || workspace.lifecycleEnabled !== true || workspace.activeOperationId) return null;
    if (await hasVmMigrationFence(tx, firestore, workspaceId)) return {fenced: true};
    if (Number(workspace.runtimeScheduleLease?.expiresAt || 0) > now.getTime()) return {busy: true};
    const revision = Number.isSafeInteger(workspace.runtimePolicyRevision) ? workspace.runtimePolicyRevision : 0;
    tx.update(ref, {runtimeScheduleLease: {token, expiresAt: now.getTime() + LEASE_MS}});
    return {token, revision, workspaceId, ref};
  });
}

async function completeClaim(claim, updates, firestore) {
  await firestore.runTransaction(async tx => {
    const workspace = (await tx.get(claim.ref)).data();
    if (!workspace || workspace.runtimeScheduleLease?.token !== claim.token) return;
    const revision = Number.isSafeInteger(workspace.runtimePolicyRevision) ? workspace.runtimePolicyRevision : 0;
    const stale = revision !== claim.revision || policyFor(workspace).mode !== "scheduled";
    tx.update(claim.ref, {runtimeScheduleLease: null, ...(!stale ? updates : {})});
  });
}

module.exports = {MAX_SCAN, LEASE_MS, createVmRuntimePolicyService, policyFor};
