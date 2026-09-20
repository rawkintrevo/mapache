"use strict";

const {admin: defaultAdmin, db: defaultDb} = require("./backendContext");
const {httpError, serialize, timestampMillis} = require("./backendUtils.helpers");
const {
  buildAutomationDefinition,
  normalizeAutomationMutation,
  normalizeAutomationSettings,
  normalizeModelSelection,
  validateDefinitionRevision,
} = require("./automationValidation.helpers");

const AUTOMATION_PUBLIC_FIELDS = Object.freeze([
  "name", "prompt", "enabled", "cron", "timezone", "allowParallelWithMain",
  "modelSelection", "resources", "revision", "deleted", "deletedAt", "nextRunAt",
  "lastRunAt", "lastRunId", "createdAt", "updatedAt",
]);
const AUTOMATION_MUTABLE_FIELD_SET = new Set([
  "name", "prompt", "enabled", "cron", "timezone", "allowParallelWithMain",
  "modelSelection", "modelId", "providerId", "resources",
]);

function createAutomationDefinitionsService(dependencies = {}) {
  const firestore = dependencies.db || defaultDb;
  const firestoreAdmin = dependencies.admin || defaultAdmin;
  return {
    createAutomation: (uid, workspaceId, payload) => createAutomation(uid, workspaceId, payload, {
      firestore, firestoreAdmin, requireWorkspace: dependencies.requireWorkspace,
    }),
    deleteAutomation: (uid, workspaceId, automationId, payload) => deleteAutomation(
        uid, workspaceId, automationId, payload, {firestore, firestoreAdmin, requireWorkspace: dependencies.requireWorkspace},
    ),
    getAutomation: (uid, workspaceId, automationId) => getAutomation(
        uid, workspaceId, automationId, {firestore, firestoreAdmin, requireWorkspace: dependencies.requireWorkspace},
    ),
    getAutomationSettings: (uid, workspaceId) => getAutomationSettings(
        uid, workspaceId, {firestore, firestoreAdmin, requireWorkspace: dependencies.requireWorkspace},
    ),
    listAutomations: (uid, workspaceId) => listAutomations(
        uid, workspaceId, {firestore, firestoreAdmin, requireWorkspace: dependencies.requireWorkspace},
    ),
    updateAutomation: (uid, workspaceId, automationId, payload) => updateAutomation(
        uid, workspaceId, automationId, payload, {firestore, firestoreAdmin, requireWorkspace: dependencies.requireWorkspace},
    ),
    updateAutomationSettings: (uid, workspaceId, payload) => updateAutomationSettings(
        uid, workspaceId, payload, {firestore, firestoreAdmin, requireWorkspace: dependencies.requireWorkspace},
    ),
  };
}

async function listAutomations(uid, workspaceId, dependencies = {}) {
  const {workspaceRef} = await ownedWorkspace(uid, workspaceId, dependencies);
  const snap = await workspaceRef.collection("automations").get();
  return snap.docs
      .map(toAutomationDto)
      .filter((automation) => automation.deleted !== true)
      .sort((left, right) => timestampMillis(right.updatedAt) - timestampMillis(left.updatedAt));
}

async function getAutomation(uid, workspaceId, automationId, dependencies = {}) {
  const {workspaceRef} = await ownedWorkspace(uid, workspaceId, dependencies);
  const ref = workspaceRef.collection("automations").doc(automationId);
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, "automation_not_found");
  return toAutomationDto(snap);
}

async function createAutomation(uid, workspaceId, payload = {}, dependencies = {}) {
  const {workspaceRef, workspace} = await ownedWorkspace(uid, workspaceId, dependencies);
  const timezone = await resolveTimezone(uid, payload, dependencies);
  const modelSelection = resolveModelSelection(payload, workspace);
  const input = {
    ...payload,
    timezone,
    ...(modelSelection ? {modelSelection} : {}),
  };
  const normalized = normalizeAutomationMutation(input);
  assertCanEnable(normalized, workspace);
  const ref = workspaceRef.collection("automations").doc();
  const now = serverTimestamp(dependencies.firestoreAdmin);
  const definition = buildAutomationDefinition(normalized, {
    ownerUid: uid,
    workspaceId,
    createdAt: now,
    updatedAt: now,
    revision: 1,
  });
  await dependencies.firestore.runTransaction(async (transaction) => {
    transaction.set(ref, definition);
    writeAudit(transaction, ref, {
      actorUid: uid,
      changedFields: Object.keys(normalized).filter((field) => AUTOMATION_MUTABLE_FIELD_SET.has(field)),
      now,
    }, dependencies.firestoreAdmin);
  });
  return toAutomationDto(await ref.get());
}

async function updateAutomation(uid, workspaceId, automationId, payload = {}, dependencies = {}) {
  const {workspaceRef, workspace} = await ownedWorkspace(uid, workspaceId, dependencies);
  const expectedRevision = requireExpectedRevision(payload);
  const mutationPayload = {...payload};
  delete mutationPayload.expectedRevision;
  const ref = workspaceRef.collection("automations").doc(automationId);
  const patch = normalizeAutomationMutation(mutationPayload, {partial: true});
  const now = serverTimestamp(dependencies.firestoreAdmin);
  const pendingRuns = queuedRunQuery(dependencies.firestore, workspaceId);
  await dependencies.firestore.runTransaction(async (transaction) => {
    const [snap, queuedRuns] = await Promise.all([
      transaction.get(ref),
      pendingRuns ? transaction.get(pendingRuns) : Promise.resolve({docs: []}),
    ]);
    if (!snap.exists) throw httpError(404, "automation_not_found");
    const current = snap.data() || {};
    assertRevision(current, expectedRevision);
    if (current.deleted === true) throw httpError(409, "automation_deleted");
    const merged = normalizedDefinition({...current, ...patch}, workspace);
    assertCanEnable(merged, workspace);
    const disabling = current.enabled === true && merged.enabled === false;
    const updates = {
      ...merged,
      revision: expectedRevision + 1,
      updatedAt: now,
      ...(disabling ? {nextRunAt: null} : {}),
    };
    transaction.update(ref, updates);
    if (disabling) cancelQueuedRuns(transaction, queuedRuns.docs, automationId, now, "definition_disabled");
    writeAudit(transaction, ref, {
      actorUid: uid,
      changedFields: Object.keys(patch),
      now,
    }, dependencies.firestoreAdmin);
  });
  return toAutomationDto(await ref.get());
}

async function deleteAutomation(uid, workspaceId, automationId, payload = {}, dependencies = {}) {
  const {workspaceRef} = await ownedWorkspace(uid, workspaceId, dependencies);
  const expectedRevision = requireExpectedRevision(payload);
  const ref = workspaceRef.collection("automations").doc(automationId);
  const now = serverTimestamp(dependencies.firestoreAdmin);
  const pendingRuns = queuedRunQuery(dependencies.firestore, workspaceId);
  await dependencies.firestore.runTransaction(async (transaction) => {
    const [snap, queuedRuns] = await Promise.all([
      transaction.get(ref),
      pendingRuns ? transaction.get(pendingRuns) : Promise.resolve({docs: []}),
    ]);
    if (!snap.exists) throw httpError(404, "automation_not_found");
    const current = snap.data() || {};
    assertRevision(current, expectedRevision);
    if (current.deleted === true) throw httpError(409, "automation_deleted");
    transaction.update(ref, {
      deleted: true,
      deletedAt: now,
      enabled: false,
      nextRunAt: null,
      revision: expectedRevision + 1,
      updatedAt: now,
    });
    cancelQueuedRuns(transaction, queuedRuns.docs, automationId, now, "definition_deleted");
    writeAudit(transaction, ref, {
      actorUid: uid,
      changedFields: ["deleted", "enabled", "nextRunAt"],
      now,
    }, dependencies.firestoreAdmin);
  });
  return {ok: true};
}

async function getAutomationSettings(uid, workspaceId, dependencies = {}) {
  const {workspace} = await ownedWorkspace(uid, workspaceId, dependencies);
  return {
    automationMaxConcurrency: Number.isSafeInteger(workspace.automationMaxConcurrency) && workspace.automationMaxConcurrency > 0 ?
      workspace.automationMaxConcurrency : 1,
  };
}

async function updateAutomationSettings(uid, workspaceId, payload = {}, dependencies = {}) {
  const {workspaceRef} = await ownedWorkspace(uid, workspaceId, dependencies);
  const normalized = normalizeAutomationSettings(payload);
  const now = serverTimestamp(dependencies.firestoreAdmin);
  await dependencies.firestore.runTransaction(async (transaction) => {
    transaction.update(workspaceRef, {
      ...normalized,
      updatedAt: now,
    });
    const auditRef = workspaceRef.collection("automationAudit").doc();
    transaction.set(auditRef, {
      actorType: "user",
      actorUid: uid,
      changedFields: ["automationMaxConcurrency"],
      timestamp: now,
      createdAt: now,
    });
  });
  return normalized;
}

async function ownedWorkspace(uid, workspaceId, dependencies = {}) {
  if (typeof dependencies.requireWorkspace === "function") {
    const workspace = await dependencies.requireWorkspace(uid, workspaceId);
    return {
      workspace,
      workspaceRef: dependencies.firestore.collection("workspaces").doc(workspaceId),
    };
  }
  const workspaceRef = dependencies.firestore.collection("workspaces").doc(workspaceId);
  const snap = await workspaceRef.get();
  if (!snap.exists) throw httpError(404, "workspace_not_found");
  const workspace = snap.data() || {};
  if (workspace.ownerUid !== uid) throw httpError(403, "workspace_forbidden");
  return {workspace, workspaceRef};
}

async function resolveTimezone(uid, payload, dependencies) {
  if (Object.prototype.hasOwnProperty.call(payload, "timezone")) return payload.timezone;
  const userSnap = await dependencies.firestore.collection("users").doc(uid).get();
  return userSnap.exists && userSnap.data()?.timezone ? userSnap.data().timezone : "UTC";
}

function resolveModelSelection(payload = {}, workspace = {}) {
  if (Object.prototype.hasOwnProperty.call(payload, "modelSelection") ||
      Object.prototype.hasOwnProperty.call(payload, "modelId") ||
      Object.prototype.hasOwnProperty.call(payload, "providerId")) {
    return normalizeModelSelection(payload);
  }
  const saved = workspace.automationModelSelection || workspace.modelSelection ||
    workspace.agentModelSelection || workspace.settings?.automation?.modelSelection;
  if (!saved) return null;
  try {
    return normalizeModelSelection({modelSelection: saved});
  } catch (error) {
    return null;
  }
}

function normalizedDefinition(definition, workspace) {
  const normalized = normalizeAutomationMutation({
    name: definition.name,
    prompt: definition.prompt,
    enabled: definition.enabled,
    cron: definition.cron,
    timezone: definition.timezone,
    allowParallelWithMain: definition.allowParallelWithMain,
    modelSelection: definition.modelSelection,
    resources: definition.resources,
  });
  if (!normalized.modelSelection) {
    const saved = resolveModelSelection({}, workspace);
    if (saved) normalized.modelSelection = saved;
  }
  return normalized;
}

function assertCanEnable(definition, workspace) {
  if (!definition.enabled) return;
  if (!definition.modelSelection) throw httpError(409, "missing_model_selection");
  const storageState = String(workspace.sharedStorageState || workspace.sharedStorage?.state || "").trim().toLowerCase();
  if (storageState !== "ready") throw httpError(409, "automation_shared_storage_not_ready");
}

function requireExpectedRevision(payload = {}) {
  if (!Object.prototype.hasOwnProperty.call(payload, "expectedRevision")) {
    throw httpError(400, "automation_revision_required");
  }
  try {
    return validateDefinitionRevision(payload.expectedRevision);
  } catch (error) {
    throw httpError(400, "invalid_automation_revision", error);
  }
}

function assertRevision(definition, expectedRevision) {
  if (Number(definition.revision) !== expectedRevision) throw httpError(409, "revision_conflict");
}

function queuedRunQuery(firestore, workspaceId) {
  if (!firestore || typeof firestore.collection !== "function") return null;
  let query = firestore.collection("automationRuns");
  if (typeof query.where !== "function") return null;
  query = query.where("workspaceId", "==", workspaceId).where("status", "==", "queued");
  return typeof query.get === "function" ? query : null;
}

function cancelQueuedRuns(transaction, docs, automationId, now, reason) {
  docs.filter((doc) => doc.data()?.automationId === automationId).forEach((doc) => {
    const run = doc.data() || {};
    if (run.status !== "queued") return;
    transaction.update(doc.ref, {
      status: "canceled",
      cleanupState: "complete",
      endedAt: now,
      updatedAt: now,
      cancellationReason: reason,
    });
  });
}

function writeAudit(transaction, automationRef, {actorUid, changedFields, now}, firestoreAdmin) {
  const auditRef = automationRef.collection("audit").doc();
  transaction.set(auditRef, {
    actorType: "user",
    actorUid,
    changedFields: [...new Set(changedFields)].sort(),
    timestamp: now,
    createdAt: now,
  });
}

function toAutomationDto(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    ...serialize(Object.fromEntries(AUTOMATION_PUBLIC_FIELDS
        .filter((field) => Object.prototype.hasOwnProperty.call(data, field))
        .map((field) => [field, data[field]]))),
  };
}

function serverTimestamp(firestoreAdmin = defaultAdmin) {
  return firestoreAdmin.firestore.FieldValue.serverTimestamp();
}

module.exports = {
  createAutomationDefinitionsService,
  createAutomation,
  deleteAutomation,
  getAutomation,
  getAutomationSettings,
  listAutomations,
  updateAutomation,
  updateAutomationSettings,
};
