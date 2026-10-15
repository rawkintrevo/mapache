"use strict";

const crypto = require("node:crypto");
const logger = require("firebase-functions/logger");
const {admin: defaultAdmin, db: defaultDb} = require("./backendContext");
const {httpError, toClientDoc} = require("./backendUtils.helpers");
const {isMarkedRuntimeSession} = require("./runtimeReservation.helpers");
const {isAutomationRuntime} = require("./runtimePaths.helpers");
const {
  getNextRuntimeScheduleStart,
  getRuntimeScheduleState,
  normalizeRuntimePolicy,
} = require("./runtimeSchedule.helpers");

const PAGE_SIZE = 200;
const MAX_PAGES_PER_TICK = 5;
const LEASE_MS = 10 * 60 * 1000;
const ACTIVE_SESSION_STATES = new Set(["running", "provisioning", "restarting", "resizing", "stopping", "stop_failed", "delete_failed"]);
const TRANSITIONING_SESSION_STATES = new Set(["provisioning", "restarting", "resizing", "stopping"]);
const SCHEDULE_CURSOR_DOC = "runtimeScheduleCursor";

function createWorkspaceRuntimeScheduleService(dependencies = {}) {
  const shared = {
    admin: dependencies.admin || defaultAdmin,
    db: dependencies.db || defaultDb,
    createSession: dependencies.createSession,
    requireSession: dependencies.requireSession,
    restartSession: dependencies.restartSession,
    restartSessionForSchedule: dependencies.restartSessionForSchedule || dependencies.restartSession,
    sessionCollection: dependencies.sessionCollection,
    listScheduledWorkspaces: dependencies.listScheduledWorkspaces,
    stopSessionForSchedule: dependencies.stopSessionForSchedule || dependencies.stopSession,
    now: dependencies.now,
    maxPages: dependencies.maxPages,
  };
  return {
    getWorkspaceRuntimePolicy: (uid, workspaceId) => getWorkspaceRuntimePolicy(uid, workspaceId, shared),
    reconcileWorkspace: (workspaceId, now) => reconcileWorkspaceRuntimeSchedule(workspaceId, now, shared),
    runTick: (event = {}) => runRuntimeScheduleTick(event, shared),
    setSessionLongRunning: (uid, workspaceId, sessionId, payload) =>
      setSessionLongRunning(uid, workspaceId, sessionId, payload, shared),
    updatePolicy: (uid, workspaceId, payload) => updateWorkspaceRuntimePolicy(uid, workspaceId, payload, shared),
  };
}

async function getWorkspaceRuntimePolicy(uid, workspaceId, dependencies = {}) {
  const workspaceRef = workspaceRefFor(workspaceId, dependencies);
  const snap = await workspaceRef.get();
  if (!snap.exists) throw httpError(404, "workspace_not_found");
  const workspace = snap.data() || {};
  assertWorkspaceOwnerAndAvailable(workspace, uid);
  const session = await canonicalMainSession(workspaceId, workspace, dependencies);
  return {
    runtimePolicy: resolveStoredPolicy(workspace, session),
    runtimeScheduleError: workspace.runtimeScheduleError || null,
    runtimeScheduleManualPauseWindowKey: workspace.runtimeScheduleManualPauseWindowKey || null,
    runtimeScheduleNextEvent: workspace.runtimeScheduleNextEvent || null,
    runtimeScheduleStatus: workspace.runtimeScheduleStatus || null,
  };
}

async function updateWorkspaceRuntimePolicy(uid, workspaceId, payload, dependencies = {}) {
  const firestore = dependencies.db || defaultDb;
  const firestoreAdmin = dependencies.admin || defaultAdmin;
  const workspaceRef = workspaceRefFor(workspaceId, dependencies);
  let policy;
  await firestore.runTransaction(async (transaction) => {
    const workspaceSnap = await transaction.get(workspaceRef);
    if (!workspaceSnap.exists) throw httpError(404, "workspace_not_found");
    const workspace = workspaceSnap.data() || {};
    assertWorkspaceOwnerAndAvailable(workspace, uid);
    const current = resolveStoredPolicy(workspace);
    policy = normalizeRuntimePolicy(payload, current);
    const revision = Number.isSafeInteger(workspace.runtimePolicyRevision) ? workspace.runtimePolicyRevision + 1 : 1;
    const update = {
      runtimePolicy: policy,
      runtimePolicyRevision: revision,
      updatedAt: firestoreAdmin.firestore.FieldValue.serverTimestamp(),
    };
    if (policy.mode !== "scheduled") {
      update.runtimeScheduleStatus = firestoreAdmin.firestore.FieldValue.delete();
      update.runtimeScheduleNextEvent = firestoreAdmin.firestore.FieldValue.delete();
      update.runtimeScheduleError = firestoreAdmin.firestore.FieldValue.delete();
      update.runtimeScheduleManualPauseWindowKey = firestoreAdmin.firestore.FieldValue.delete();
    }

    const canonicalSessionId = String(workspace.canonicalSessionId || "").trim();
    const sessionRef = canonicalSessionId ? dependencies.sessionCollection(workspaceId).doc(canonicalSessionId) : null;
    const sessionSnap = sessionRef ? await transaction.get(sessionRef) : null;
    transaction.update(workspaceRef, update);
    if (sessionSnap?.exists && !isAutomationRuntime(sessionSnap.data() || {})) {
      transaction.update(sessionRef, {
        longRunning: policy.mode === "keep-running",
        updatedAt: firestoreAdmin.firestore.FieldValue.serverTimestamp(),
      });
    }
  });

  if (policy.mode === "scheduled") await reconcileWorkspaceRuntimeSchedule(workspaceId, undefined, dependencies);
  const snap = await workspaceRef.get();
  return toClientDoc(snap);
}

async function setSessionLongRunning(uid, workspaceId, sessionId, payload, dependencies = {}) {
  const {sessionRef, sessionSnap, workspace} = await dependencies.requireSession(uid, workspaceId, sessionId);
  const session = sessionSnap.data() || {};
  if (isAutomationRuntime(session)) throw httpError(409, "automation_session_controlled");
  if (!isMarkedRuntimeSession(session)) throw httpError(409, "long_running_unavailable");
  if (!payload || typeof payload.enabled !== "boolean") throw httpError(400, "invalid_long_running");
  await updateWorkspaceRuntimePolicy(uid, workspaceId, {mode: payload.enabled ? "keep-running" : "idle"}, dependencies);
  await sessionRef.update({
    longRunning: payload.enabled,
    updatedAt: (dependencies.admin || defaultAdmin).firestore.FieldValue.serverTimestamp(),
  });
  return toClientDoc(await sessionRef.get());
}

async function runRuntimeScheduleTick(event = {}, dependencies = {}) {
  const firestore = dependencies.db || defaultDb;
  const now = dependencies.now ? asDate(dependencies.now()) : new Date();
  const {docs, pages, capped} = await listScheduledWorkspaceDocs(now, dependencies);

  const values = [];
  for (const doc of docs) values.push(await reconcileWorkspaceRuntimeSchedule(doc.id, now, dependencies));
  const result = {
    checked: docs.length,
    opened: values.filter((value) => value.action === "start_requested").length,
    closed: values.filter((value) => value.action === "stopped").length,
    failed: values.filter((value) => value.failed).length,
    skipped: values.filter((value) => value.skipped).length,
    pages,
    capped,
  };
  logger.info("workspace runtime schedule tick complete", result);
  return result;
}

async function listScheduledWorkspaceDocs(now, dependencies = {}) {
  if (typeof dependencies.listScheduledWorkspaces === "function") {
    const result = await dependencies.listScheduledWorkspaces(now);
    return {docs: result.docs || [], pages: result.pages || 1, capped: result.capped === true};
  }
  const firestore = dependencies.db || defaultDb;
  const firestoreAdmin = dependencies.admin || defaultAdmin;
  const maxPages = Number.isSafeInteger(dependencies.maxPages) && dependencies.maxPages > 0 ?
    dependencies.maxPages : MAX_PAGES_PER_TICK;
  const cursorRef = firestore.collection("appConfig").doc(SCHEDULE_CURSOR_DOC);
  const cursorState = await cursorRef.get();
  let queryCursor = null;
  let cursorPath = String(cursorState.exists ? cursorState.data()?.lastWorkspacePath || "" : "").trim();
  if (cursorPath && typeof firestore.doc === "function") {
    const cursorSnap = await firestore.doc(cursorPath).get();
    queryCursor = cursorSnap.exists ? cursorSnap : null;
    if (!queryCursor) cursorPath = "";
  }

  const docs = [];
  const seenPaths = new Set();
  let pages = 0;
  let lastPageDoc = null;
  let wrapped = false;
  let nextCursorPath = cursorPath;
  while (pages < maxPages) {
    let query = firestore.collection("workspaces")
        .where("runtimePolicy.mode", "==", "scheduled")
        .limit(PAGE_SIZE);
    if (queryCursor && typeof query.startAfter === "function") query = query.startAfter(queryCursor);
    const snap = await query.get();
    const pageDocs = snap.docs || [];
    pages++;
    if (!pageDocs.length) {
      if (!docs.length && queryCursor && !wrapped) {
        queryCursor = null;
        cursorPath = "";
        nextCursorPath = "";
        wrapped = true;
        continue;
      }
      nextCursorPath = "";
      break;
    }

    const rootWorkspaceDocs = pageDocs.filter((doc) => doc.ref?.parent?.id === "workspaces" && !doc.ref?.parent?.parent);
    for (const doc of rootWorkspaceDocs) {
      const path = doc.ref?.path || doc.id;
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      docs.push(doc);
    }
    lastPageDoc = pageDocs[pageDocs.length - 1];
    queryCursor = lastPageDoc;
    nextCursorPath = lastPageDoc.ref?.path || "";
    if (pageDocs.length < PAGE_SIZE) {
      nextCursorPath = "";
      break;
    }
  }

  await cursorRef.set({
    lastWorkspacePath: nextCursorPath,
    updatedAt: firestoreAdmin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
  return {docs, pages, capped: pages >= maxPages && Boolean(lastPageDoc && nextCursorPath)};
}

async function reconcileWorkspaceRuntimeSchedule(workspaceId, nowValue, dependencies = {}) {
  const firestore = dependencies.db || defaultDb;
  const now = nowValue ? asDate(nowValue) : dependencies.now ? asDate(dependencies.now()) : new Date();
  const claim = await claimWorkspace(workspaceId, now, dependencies);
  if (!claim) return {workspaceId, skipped: true, reason: "not_scheduled_or_unavailable"};
  if (claim.busy) return {workspaceId, skipped: true, reason: "reconciliation_in_progress"};
  const workspaceRef = claim.workspaceRef;
  let result = {workspaceId, action: "none", failed: false};
  let error = null;
  let attemptedAction = "reconcile";
  try {
    const currentSnap = await workspaceRef.get();
    if (!currentSnap.exists) return {workspaceId, skipped: true, reason: "workspace_missing"};
    const workspace = currentSnap.data() || {};
    if (workspace.runtimePolicyRevision !== claim.revision || workspace.runtimePolicy?.mode !== "scheduled") {
      result = {workspaceId, skipped: true, stale: true, reason: "policy_changed"};
    } else {
      const schedule = workspace.runtimePolicy.schedule;
      const state = getRuntimeScheduleState(schedule, now);
      const manualPause = state.active && workspace.runtimeScheduleManualPauseWindowKey === state.windowKey;
      const nextEvent = manualPause ? getNextRuntimeScheduleStart(schedule, now) : state.nextEvent;
      const session = await canonicalMainSession(workspaceId, workspace, dependencies);
      const sessionStatus = String(session?.status || "").trim().toLowerCase();

      if (state.active && manualPause) {
        result = {workspaceId, action: "manually_paused", failed: false};
      } else if (state.active) {
        if (!session) {
          attemptedAction = "start";
          await dependencies.createSession(workspace.ownerUid, workspaceId, {
            name: "Scheduled workspace",
            operationId: runtimeScheduleOperationId(workspaceId, state.windowKey),
            runtimeScheduleStart: true,
          });
          result = {workspaceId, action: "start_requested", failed: false};
        } else if (sessionStatus === "running" || TRANSITIONING_SESSION_STATES.has(sessionStatus)) {
          result = {workspaceId, action: sessionStatus === "running" ? "already_running" : "startup_in_progress", failed: false};
        } else {
          attemptedAction = "start";
          await dependencies.restartSessionForSchedule(workspace.ownerUid, workspaceId, session.id);
          result = {workspaceId, action: "start_requested", failed: false};
        }
      } else if (session && isPotentiallyActive(session)) {
        attemptedAction = "stop";
        await dependencies.stopSessionForSchedule(workspace.ownerUid, workspaceId, session.id);
        result = {workspaceId, action: "stopped", failed: false};
      } else {
        result = {workspaceId, action: "outside_window", failed: false};
      }

      await completeClaim(claim, {
        runtimeScheduleStatus: state.active ? manualPause ? "manually_paused" : "open" : "closed",
        runtimeScheduleNextEvent: serializeNextEvent(nextEvent, schedule.timezone),
        runtimeScheduleError: null,
        runtimeScheduleLastAction: result.action,
        runtimeScheduleReconciledAt: now,
      }, dependencies);
      if (result.action === "start_requested" || result.action === "already_running" || result.action === "outside_window") {
        result.failed = false;
      }
      return result;
    }
  } catch (caught) {
    error = caught;
    result = {
      workspaceId,
      action: "failed",
      failed: true,
      errorCode: safeErrorCode(caught, "runtime_schedule_reconcile_failed"),
    };
  }

  await completeClaim(claim, {
    runtimeScheduleError: {
      action: attemptedAction,
      code: error ? safeErrorCode(error, "runtime_schedule_reconcile_failed") : "runtime_schedule_policy_changed",
      at: now,
    },
    runtimeScheduleLastAction: result.action,
    runtimeScheduleReconciledAt: now,
  }, dependencies);
  if (result.stale) {
    const latest = await workspaceRef.get();
    if (latest.exists && latest.data()?.runtimePolicy?.mode === "scheduled") {
      return reconcileWorkspaceRuntimeSchedule(workspaceId, now, dependencies);
    }
  }
  if (error) logger.warn("workspace runtime schedule reconciliation failed", {workspaceId, errorCode: result.errorCode});
  return result;
}

async function claimWorkspace(workspaceId, now, dependencies = {}) {
  const firestore = dependencies.db || defaultDb;
  const firestoreAdmin = dependencies.admin || defaultAdmin;
  const workspaceRef = workspaceRefFor(workspaceId, dependencies);
  const token = crypto.randomUUID();
  let claim = null;
  await firestore.runTransaction(async (transaction) => {
    const snap = await transaction.get(workspaceRef);
    if (!snap.exists) return;
    const workspace = snap.data() || {};
    if (workspace.runtimePolicy?.mode !== "scheduled" || !workspace.runtimePolicy.schedule || isWorkspaceUnavailable(workspace)) return;
    const lease = workspace.runtimeScheduleLease || {};
    if (Number(lease.expiresAt || 0) > now.getTime()) {
      claim = {busy: true, workspaceId, workspaceRef};
      return;
    }
    const revision = Number.isSafeInteger(workspace.runtimePolicyRevision) ? workspace.runtimePolicyRevision : 0;
    transaction.update(workspaceRef, {
      runtimeScheduleLease: {token, expiresAt: now.getTime() + LEASE_MS},
    });
    claim = {token, revision, workspaceId, workspaceRef, ownerUid: workspace.ownerUid, firestoreAdmin};
  });
  return claim;
}

async function completeClaim(claim, updates, dependencies = {}) {
  const firestore = dependencies.db || defaultDb;
  const firestoreAdmin = dependencies.admin || defaultAdmin;
  await firestore.runTransaction(async (transaction) => {
    const snap = await transaction.get(claim.workspaceRef);
    if (!snap.exists) return;
    const workspace = snap.data() || {};
    if (workspace.runtimeScheduleLease?.token !== claim.token) return;
    const latestRevision = Number.isSafeInteger(workspace.runtimePolicyRevision) ? workspace.runtimePolicyRevision : 0;
    const stale = latestRevision !== claim.revision || workspace.runtimePolicy?.mode !== "scheduled";
    transaction.update(claim.workspaceRef, {
      runtimeScheduleLease: firestoreAdmin.firestore.FieldValue.delete(),
      ...(!stale ? updates : {}),
    });
  });
}

async function canonicalMainSession(workspaceId, workspace, dependencies = {}) {
  const sessionsRef = dependencies.sessionCollection(workspaceId);
  const snap = await sessionsRef.get();
  const sessions = (snap.docs || [])
      .filter((doc) => !isAutomationRuntime(doc.data() || {}))
      .map((doc) => ({id: doc.id, ...doc.data()}));
  const canonicalId = String(workspace.canonicalSessionId || "").trim();
  const canonical = canonicalId ? sessions.find((session) => session.id === canonicalId) : null;
  if (canonical) return canonical;
  return sessions.sort((a, b) => sessionPriority(b) - sessionPriority(a))[0] || null;
}

function sessionPriority(session) {
  const status = String(session.status || "").trim().toLowerCase();
  const active = isPotentiallyActive(session) ? 1 : 0;
  const updated = timestampMillis(session.updatedAt) || timestampMillis(session.createdAt) || 0;
  return active * 1e15 + updated;
}

function isPotentiallyActive(session = {}) {
  const status = String(session.status || "").trim().toLowerCase();
  if (ACTIVE_SESSION_STATES.has(status)) return true;
  return Boolean(session.serviceUrl) && !["stopped", "needs_image", "needs_service", "provision_failed"].includes(status);
}

function resolveStoredPolicy(workspace = {}, session = null) {
  const stored = workspace.runtimePolicy;
  if (stored && ["idle", "keep-running", "scheduled"].includes(stored.mode)) {
    return {mode: stored.mode, schedule: stored.schedule || null};
  }
  return {mode: session?.longRunning === true ? "keep-running" : "idle", schedule: null};
}

function serializeNextEvent(event, timezone) {
  return {action: event.action, at: event.at, windowKey: event.windowKey, timezone};
}

function runtimeScheduleOperationId(workspaceId, windowKey) {
  const digest = crypto.createHash("sha256").update(`${workspaceId}/${windowKey}`).digest("hex").slice(0, 40);
  return `runtime-schedule-${digest}`;
}

function workspaceRefFor(workspaceId, dependencies = {}) {
  const firestore = dependencies.db || defaultDb;
  return firestore.collection("workspaces").doc(workspaceId);
}

function assertWorkspaceOwnerAndAvailable(workspace, uid) {
  if (workspace.ownerUid !== uid) throw httpError(403, "workspace_forbidden");
  if (isWorkspaceUnavailable(workspace)) throw httpError(409, "workspace_unavailable");
}

function isWorkspaceUnavailable(workspace = {}) {
  return workspace.deleted === true || ["deleting", "deleted"].includes(
    String(workspace.lifecycle || workspace.status || "").trim().toLowerCase(),
  );
}

function safeErrorCode(error, fallback) {
  const candidate = String(error?.publicMessage || error?.code || error?.message || "").trim();
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(candidate) ? candidate : fallback;
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : 0;
}

function asDate(value) {
  const date = value instanceof Date ? value : value && typeof value.toDate === "function" ? value.toDate() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_runtime_schedule_time");
  return date;
}

module.exports = {
  createWorkspaceRuntimeScheduleService,
  getWorkspaceRuntimePolicy,
  reconcileWorkspaceRuntimeSchedule,
  runRuntimeScheduleTick,
  setSessionLongRunning,
  updateWorkspaceRuntimePolicy,
};
