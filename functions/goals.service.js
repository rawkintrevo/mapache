"use strict";

const {admin: defaultAdmin, db: defaultDb} = require("./backendContext");
const {httpError} = require("./backendUtils.helpers");
const {
  GOAL_SCHEMA_VERSION,
  assertGoalTransition,
  createOperationId,
  hashGoalPayload,
  normalizeGoalAction,
  normalizeGoalAnswer,
  normalizeGoalClientDoc,
  normalizeGoalPageSize,
  normalizeGoalPayload,
} = require("./goals.helpers");

function createGoalsService(dependencies = {}) {
  return {
    answerGoalQuestion: (uid, workspaceId, goalId, questionId, payload) =>
      answerGoalQuestion(uid, workspaceId, goalId, questionId, payload, dependencies),
    createGoal: (uid, workspaceId, payload) => createGoal(uid, workspaceId, payload, dependencies),
    getGoal: (uid, workspaceId, goalId) => getGoal(uid, workspaceId, goalId, dependencies),
    getGoalRuntime: (uid, workspaceId, goalId) => getGoalRuntime(uid, workspaceId, goalId, dependencies),
    getGoalOperation: (uid, workspaceId, operationId) => getGoalOperation(uid, workspaceId, operationId, dependencies),
    listGoalEvents: (uid, workspaceId, goalId, query) => listGoalEvents(uid, workspaceId, goalId, query, dependencies),
    listGoals: (uid, workspaceId, query) => listGoals(uid, workspaceId, query, dependencies),
    updateGoal: (uid, workspaceId, goalId, payload) => updateGoal(uid, workspaceId, goalId, payload, dependencies),
    actionGoal: (uid, workspaceId, goalId, payload) => actionGoal(uid, workspaceId, goalId, payload, dependencies),
  };
}

async function createGoal(uid, workspaceId, payload, dependencies = {}) {
  await requireWorkspace(dependencies, uid, workspaceId);
  const values = normalizeGoalPayload(payload);
  const db = dependencies.db || defaultDb;
  const admin = dependencies.admin || defaultAdmin;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = db.collection("workspaces").doc(workspaceId).collection("goals").doc();
  const goal = {
    schemaVersion: GOAL_SCHEMA_VERSION,
    goalId: ref.id,
    ownerUid: uid,
    workspaceId,
    title: values.title,
    objective: values.objective,
    mode: values.mode,
    auditEnabled: values.auditEnabled,
    engineGoalId: null,
    lifecycle: "draft",
    activeRunId: null,
    assignedSessionId: null,
    revision: 0,
    taskCounts: {total: 0, completed: 0, skipped: 0},
    currentTaskId: null,
    audit: {enabled: values.auditEnabled, status: "not_started"},
    usage: {inputTokens: null, outputTokens: null, elapsedMs: 0},
    checkpoint: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(goal);
  await writeGoalEvent(ref, {eventId: "created", type: "goal_created", lifecycle: "draft", revision: 0}, admin).catch(() => {});
  return normalizeGoalClientDoc(await ref.get());
}

async function listGoals(uid, workspaceId, query = {}, dependencies = {}) {
  await requireWorkspace(dependencies, uid, workspaceId);
  const db = dependencies.db || defaultDb;
  const pageSize = normalizeGoalPageSize(query && query.pageSize);
  let request = db.collection("workspaces").doc(workspaceId).collection("goals").orderBy("updatedAt", "desc").limit(pageSize);
  if (query && query.startAfter && typeof request.startAfter === "function") request = request.startAfter(String(query.startAfter));
  const snap = await request.get();
  const goals = snap.docs.map(normalizeGoalClientDoc);
  return {
    goals,
    nextCursor: goals.length === pageSize ? goals[goals.length - 1].id : "",
  };
}

async function getGoal(uid, workspaceId, goalId, dependencies = {}) {
  const {ref, data} = await requireGoal(dependencies, uid, workspaceId, goalId);
  return normalizeGoalClientDoc({id: ref.id, ...data});
}

async function getGoalRuntime(uid, workspaceId, goalId, dependencies = {}) {
  const {data} = await requireGoal(dependencies, uid, workspaceId, goalId);
  const sessionId = String(data.assignedSessionId || "").trim();
  if (!sessionId) return {ok: false, error: "goal_not_assigned", pendingUiRequests: []};
  const session = await requirePiSession(dependencies, uid, workspaceId, sessionId);
  const runtime = await requestRunner(dependencies, session, "/goals/snapshot", {
    method: "GET",
    notFoundError: "goal_bridge_unavailable",
    notFoundStatus: 503,
    failureError: "goal_snapshot_failed",
    timeoutMs: 10_000,
  });
  return {
    ok: true,
    goalId: String(goalId),
    sessionId,
    ...(runtime && typeof runtime === "object" ? runtime : {}),
  };
}

async function updateGoal(uid, workspaceId, goalId, payload, dependencies = {}) {
  const {ref, data} = await requireGoal(dependencies, uid, workspaceId, goalId);
  if (data.lifecycle !== "draft") throw httpError(409, "goal_revision_requires_action");
  const values = normalizeGoalPayload(payload, {allowRevision: true});
  assertExpectedRevision(data, values.expectedRevision);
  const admin = dependencies.admin || defaultAdmin;
  await ref.update({
    title: values.title,
    objective: values.objective,
    mode: values.mode,
    auditEnabled: values.auditEnabled,
    "audit.enabled": values.auditEnabled,
    revision: Number(data.revision || 0) + 1,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await writeGoalEvent(ref, {type: "goal_draft_updated", revision: Number(data.revision || 0) + 1}, admin).catch(() => {});
  return normalizeGoalClientDoc(await ref.get());
}

async function actionGoal(uid, workspaceId, goalId, payload, dependencies = {}) {
  const action = normalizeGoalAction(payload);
  const goalResult = await requireGoal(dependencies, uid, workspaceId, goalId);
  const {ref, data} = goalResult;
  const operationId = action.operationId || createOperationId();
  const operationRef = ref.parent.parent.collection("goalOperations").doc(operationId);
  const operationPayload = {goalId, action: action.action, ...action};
  const payloadHash = hashGoalPayload(operationPayload);
  const existing = await operationRef.get();
  if (existing.exists) {
    const existingData = existing.data() || {};
    if (existingData.goalId !== goalId || existingData.payloadHash !== payloadHash) throw httpError(409, "goal_operation_conflict");
    return existingData.result || {operationId, status: existingData.status || "queued"};
  }
  assertExpectedRevision(data, action.expectedRevision);
  assertActionTransition(data, action);
  const admin = dependencies.admin || defaultAdmin;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const operationRecord = {
    operationId,
    goalId,
    workspaceId,
    action: action.action,
    payloadHash,
    status: "delivering",
    expectedRevision: Number(data.revision || 0),
    createdAt: now,
    updatedAt: now,
  };
  try {
    if (typeof operationRef.create === "function") await operationRef.create(operationRecord);
    else await operationRef.set(operationRecord);
  } catch (error) {
    if (error?.code !== 6 && String(error?.code) !== "6" && error?.code !== "already-exists" && error?.code !== "ALREADY_EXISTS") throw error;
    const concurrent = await operationRef.get();
    const concurrentData = concurrent.data() || {};
    if (concurrentData.goalId !== goalId || concurrentData.payloadHash !== payloadHash) throw httpError(409, "goal_operation_conflict");
    return concurrentData.result || {operationId, status: concurrentData.status || "queued"};
  }

  try {
    if (["start", "resume"].includes(action.action)) {
      await reserveGoalExecution(ref.parent.parent, {
        goalId,
        operationId,
        sessionId: action.sessionId || data.assignedSessionId || "",
        status: action.action === "start" ? "open" : "open",
      }, dependencies);
    }
    const result = await deliverGoalAction(dependencies, {
      uid,
      workspaceId,
      goalId,
      goal: data,
      action,
      operationId,
    });
    const next = applyGoalAction(data, action, result, operationId);
    if (next) await ref.update({...next, updatedAt: admin.firestore.FieldValue.serverTimestamp()});
    if (["pause", "archive", "cancel"].includes(action.action)) {
      await releaseGoalExecution(ref.parent.parent, goalId, dependencies);
    }
    const response = {operationId, status: "applied", goal: normalizeGoalClientDoc(await ref.get()), runner: result || null};
    await operationRef.update({status: "applied", result: response, updatedAt: admin.firestore.FieldValue.serverTimestamp()});
    await writeGoalEvent(ref, {
      eventId: operationId,
      type: "goal_action_applied",
      action: action.action,
      operationId,
      lifecycle: response.goal.lifecycle,
      revision: response.goal.revision,
    }, admin).catch(() => {});
    return response;
  } catch (error) {
    if (["start", "resume"].includes(action.action)) {
      await releaseGoalExecution(ref.parent.parent, goalId, dependencies).catch(() => {});
    }
    await operationRef.update({status: "failed", error: safeErrorCode(error), updatedAt: admin.firestore.FieldValue.serverTimestamp()}).catch(() => {});
    await writeGoalEvent(ref, {
      eventId: `${operationId}-failed`,
      type: "goal_action_failed",
      action: action.action,
      operationId,
      error: safeErrorCode(error),
    }, admin).catch(() => {});
    throw error;
  }
}

async function answerGoalQuestion(uid, workspaceId, goalId, questionId, payload, dependencies = {}) {
  const answer = normalizeGoalAnswer(payload);
  const cleanQuestionId = String(questionId || "").trim();
  if (!cleanQuestionId || cleanQuestionId.length > 256 || cleanQuestionId.includes("/")) throw httpError(400, "invalid_goal_question");
  const {ref, data} = await requireGoal(dependencies, uid, workspaceId, goalId);
  assertExpectedRevision(data, answer.expectedRevision);
  const sessionId = data.assignedSessionId;
  if (!sessionId) throw httpError(409, "goal_not_assigned");
  const session = await requirePiSession(dependencies, uid, workspaceId, sessionId, {requireWriter: true});
  const result = await requestRunner(dependencies, session, "/goals/commands", {
    method: "POST",
    body: {protocolVersion: 1, type: "answer", operationId: createOperationId(), goalId, questionId: cleanQuestionId, requestId: answer.requestId, answer: answer.answer, expectedRevision: answer.expectedRevision},
    notFoundError: "goal_bridge_unavailable",
    notFoundStatus: 503,
    failureError: "goal_answer_failed",
    unavailableError: "goal_structured_dialogs_unavailable",
  });
  const admin = dependencies.admin || defaultAdmin;
  await ref.update({revision: Number(data.revision || 0) + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp()});
  return {ok: true, questionId: cleanQuestionId, runner: result, goal: normalizeGoalClientDoc(await ref.get())};
}

async function listGoalEvents(uid, workspaceId, goalId, query = {}, dependencies = {}) {
  const {ref} = await requireGoal(dependencies, uid, workspaceId, goalId);
  const pageSize = normalizeGoalPageSize(query && query.pageSize);
  const collection = ref.collection("events");
  let request = collection.orderBy("createdAt", "desc").limit(pageSize);
  if (query && query.startAfter && typeof request.startAfter === "function") request = request.startAfter(String(query.startAfter));
  const snap = await request.get();
  const events = snap.docs.map((doc) => ({id: doc.id, ...doc.data()}));
  return {events, nextCursor: events.length === pageSize ? events[events.length - 1].id : ""};
}

async function getGoalOperation(uid, workspaceId, operationId, dependencies = {}) {
  await requireWorkspace(dependencies, uid, workspaceId);
  const db = dependencies.db || defaultDb;
  const ref = db.collection("workspaces").doc(workspaceId).collection("goalOperations").doc(String(operationId || ""));
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, "goal_operation_not_found");
  return {id: snap.id, ...snap.data()};
}

async function deliverGoalAction(dependencies, context) {
  const {goal, action, operationId, goalId} = context;
  if (["archive", "cancel", "focus", "unfocus", "settings"].includes(action.action) && !goal.assignedSessionId) {
    return {accepted: true, localOnly: true};
  }
  let sessionId = action.sessionId || goal.assignedSessionId;
  if (action.action === "start" && !sessionId) throw httpError(409, "goal_session_required");
  if (["start", "resume", "pause", "revise", "settings", "archive", "cancel", "focus", "unfocus"].includes(action.action)) {
    if (!sessionId) return {accepted: true, localOnly: true};
    const session = await requirePiSession(dependencies, context.uid, context.workspaceId, sessionId, {requireWriter: ["start", "resume", "revise", "settings"].includes(action.action)});
    const command = {
      protocolVersion: 1,
      type: "command",
      operationId,
      goalId,
      action: action.action,
      payload: {
        objective: action.objective || goal.objective,
        mode: action.mode || goal.mode,
        auditEnabled: action.auditEnabled ?? goal.auditEnabled,
        settings: action.settings,
        takeOverTerminal: action.takeOverTerminal === true,
      },
    };
    return requestRunner(dependencies, session, "/goals/commands", {
      method: "POST",
      body: command,
      notFoundError: "goal_bridge_unavailable",
      notFoundStatus: 503,
      failureError: "goal_command_failed",
      unavailableError: "goal_bridge_unavailable",
      timeoutMs: 30000,
    });
  }
  return {accepted: true, localOnly: true};
}

function applyGoalAction(goal, action, runner, operationId) {
  const current = String(goal.lifecycle || "draft");
  let lifecycle = current;
  if (action.action === "start") lifecycle = "open";
  if (action.action === "resume") lifecycle = "open";
  if (action.action === "pause") lifecycle = "paused";
  if (action.action === "archive" || action.action === "cancel") lifecycle = "archived";
  if (action.action === "revise") lifecycle = "ready";
  if (action.action === "focus" || action.action === "unfocus" || action.action === "settings") lifecycle = current;
  if (lifecycle !== current) assertGoalTransition(current, lifecycle);
  const update = {lifecycle, revision: Number(goal.revision || 0) + 1};
  if (action.action === "start" || action.action === "resume") {
    update.assignedSessionId = action.sessionId || goal.assignedSessionId;
    update.activeRunId = operationId;
    update.lastError = null;
  }
  if (action.action === "revise" && action.objective) {
    update.title = action.title;
    update.objective = action.objective;
    update.mode = action.mode;
    update.auditEnabled = action.auditEnabled;
    update["audit.enabled"] = action.auditEnabled;
  }
  if (runner && runner.goalId) update.engineGoalId = String(runner.goalId);
  return update;
}

function assertActionTransition(goal, action) {
  const current = String(goal.lifecycle || "draft");
  let next = current;
  if (action.action === "start" || action.action === "resume") next = "open";
  if (action.action === "pause") next = "paused";
  if (action.action === "archive" || action.action === "cancel") next = "archived";
  if (action.action === "revise") next = "ready";
  if (next !== current) assertGoalTransition(current, next);
}

async function requireGoal(dependencies, uid, workspaceId, goalId) {
  await requireWorkspace(dependencies, uid, workspaceId);
  const db = dependencies.db || defaultDb;
  const cleanId = String(goalId || "").trim();
  if (!cleanId || cleanId.length > 256 || cleanId.includes("/")) throw httpError(400, "invalid_goal_id");
  const ref = db.collection("workspaces").doc(workspaceId).collection("goals").doc(cleanId);
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, "goal_not_found");
  const data = snap.data() || {};
  if (data.ownerUid && data.ownerUid !== uid) throw httpError(403, "goal_forbidden");
  return {ref, data};
}

async function requireWorkspace(dependencies, uid, workspaceId) {
  if (typeof dependencies.requireWorkspace !== "function") throw new Error("Goals service requires requireWorkspace.");
  return dependencies.requireWorkspace(uid, workspaceId);
}

async function requirePiSession(dependencies, uid, workspaceId, sessionId, options = {}) {
  if (typeof dependencies.requireSession !== "function") throw new Error("Goals service requires requireSession.");
  const {sessionSnap} = await dependencies.requireSession(uid, workspaceId, sessionId);
  const data = sessionSnap.data() || {};
  const harness = String(data.harnessId || data.terminalKind || "").trim().toLowerCase();
  if (harness !== "pi") throw httpError(400, "goal_runner_unsupported");
  if (!data.serviceUrl || !data.shutdownToken) throw httpError(409, "no_active_session");
  if (options.requireWriter && data.syncWriterRole && data.syncWriterRole !== "writer") throw httpError(409, "goal_writer_conflict");
  return {id: sessionId, ...data};
}

async function reserveGoalExecution(workspaceRef, reservation, dependencies = {}) {
  const db = dependencies.db || defaultDb;
  const admin = dependencies.admin || defaultAdmin;
  const controlRef = workspaceRef.collection("goalControl").doc("execution");
  const write = async (transaction) => {
    const snap = transaction ? await transaction.get(controlRef) : await controlRef.get();
    const current = snap.exists ? snap.data() || {} : {};
    const active = ["preparing", "drafting", "open", "running", "waiting_for_input", "pausing", "auditing"].includes(String(current.status || ""));
    if (active && current.goalId && current.goalId !== reservation.goalId) throw httpError(409, "goal_execution_busy");
    const value = {
      schemaVersion: 1,
      goalId: reservation.goalId,
      runId: reservation.operationId,
      sessionId: reservation.sessionId || null,
      status: reservation.status,
      leaseEpoch: Number(current.leaseEpoch || 0) + 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (transaction) transaction.set(controlRef, value, {merge: true});
    else await controlRef.set(value, {merge: true});
  };
  if (typeof db.runTransaction === "function") {
    await db.runTransaction((transaction) => write(transaction));
  } else {
    await write(null);
  }
}

async function releaseGoalExecution(workspaceRef, goalId, dependencies = {}) {
  const db = dependencies.db || defaultDb;
  const admin = dependencies.admin || defaultAdmin;
  const controlRef = workspaceRef.collection("goalControl").doc("execution");
  if (typeof db.runTransaction === "function") {
    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(controlRef);
      if (snap.exists && (snap.data() || {}).goalId === goalId) {
        transaction.set(controlRef, {goalId: null, runId: null, sessionId: null, status: "idle", updatedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
      }
    });
    return;
  }
  const snap = await controlRef.get();
  if (snap.exists && (snap.data() || {}).goalId === goalId) {
    await controlRef.set({goalId: null, runId: null, sessionId: null, status: "idle", updatedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
  }
}

async function requestRunner(dependencies, session, route, options) {
  if (typeof dependencies.requestRunnerJson !== "function") throw new Error("Goals service requires requestRunnerJson.");
  return dependencies.requestRunnerJson(session, route, options);
}

async function writeGoalEvent(goalRef, event, admin) {
  const eventId = String(event.eventId || createOperationId());
  const data = {...event};
  delete data.eventId;
  await goalRef.collection("events").doc(eventId).set({
    ...data,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
}

function assertExpectedRevision(goal, expectedRevision) {
  if (expectedRevision === undefined) return;
  if (Number(goal.revision || 0) !== expectedRevision) throw httpError(409, "goal_revision_conflict");
}

function safeErrorCode(error) {
  return String(error && (error.publicMessage || error.code || error.message) || "goal_operation_failed").slice(0, 256);
}

module.exports = {
  createGoalsService,
  applyGoalAction,
  assertActionTransition,
  requirePiSession,
};
