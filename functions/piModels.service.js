"use strict";

const {httpError} = require("./backendUtils.helpers");

function createPiModelsService(dependencies = {}) {
  return {
    listPiModels: (uid, workspaceId, sessionId) => listPiModels(uid, workspaceId, sessionId, dependencies),
    readPiModelsFile: (uid, workspaceId, sessionId) => readPiModelsFile(uid, workspaceId, sessionId, dependencies),
    savePiModelScope: (uid, workspaceId, sessionId, payload) => savePiModelScope(uid, workspaceId, sessionId, payload, dependencies),
    savePiModelsFile: (uid, workspaceId, sessionId, payload) => savePiModelsFile(uid, workspaceId, sessionId, payload, dependencies),
  };
}

async function readPiModelsFile(uid, workspaceId, sessionId, dependencies = {}) {
  const session = await requirePiSession(uid, workspaceId, sessionId, dependencies);
  return requestRunner(dependencies, session, "/models-file", {
    notFoundError: "runner_models_file_unsupported", notFoundStatus: 501,
    failureError: "pi_models_file_read_failed", unavailableError: "pi_models_file_unavailable",
  });
}

async function savePiModelsFile(uid, workspaceId, sessionId, payload, dependencies = {}) {
  const session = await requirePiSession(uid, workspaceId, sessionId, dependencies);
  return requestRunner(dependencies, session, "/models-file", {
    method: "PUT", body: {content: String(payload && payload.content || "")},
    notFoundError: "runner_models_file_unsupported", notFoundStatus: 501,
    failureError: "pi_models_file_save_failed", unavailableError: "pi_models_file_unavailable", timeoutMs: 30000,
  });
}

async function listPiModels(uid, workspaceId, sessionId, dependencies = {}) {
  const session = await requirePiSession(uid, workspaceId, sessionId, dependencies);
  return requestRunner(dependencies, session, "/models", {
    notFoundError: "runner_model_listing_unsupported",
    notFoundStatus: 501,
    failureError: "pi_model_list_failed",
    unavailableError: "pi_model_list_unavailable",
    timeoutMs: 45000,
  });
}

async function savePiModelScope(uid, workspaceId, sessionId, payload, dependencies = {}) {
  const session = await requirePiSession(uid, workspaceId, sessionId, dependencies);
  const scopedModels = normalizeScopedModels(payload && payload.scopedModels);
  const result = await requestRunner(dependencies, session, "/models", {
    method: "PUT",
    body: {scopedModels},
    notFoundError: "runner_model_scope_unsupported",
    notFoundStatus: 501,
    failureError: "pi_model_scope_save_failed",
    unavailableError: "pi_model_scope_unavailable",
    timeoutMs: 30000,
  });
  await session.ref.set({
    piScopedModels: scopedModels,
    piScopedModelsUpdatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
  return {...result, scopedModels};
}

async function requirePiSession(uid, workspaceId, sessionId, dependencies) {
  await dependencies.requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await dependencies.requireSession(uid, workspaceId, sessionId);
  const data = sessionSnap.data() || {};
  const harnessId = String(data.harnessId || data.terminalKind || "").trim().toLowerCase();
  if (harnessId !== "pi") throw httpError(400, "pi_models_unsupported");
  if (!data.serviceUrl) throw httpError(409, "no_active_session");
  if (!data.shutdownToken) throw httpError(501, "runner_model_listing_unsupported");
  return {id: sessionId, ...data, ref: sessionSnap.ref};
}

function requestRunner(dependencies, session, routePath, options) {
  if (typeof dependencies.requestRunnerJson !== "function") throw new Error("Pi models service requires requestRunnerJson.");
  return dependencies.requestRunnerJson(session, routePath, options);
}

function normalizeScopedModels(value) {
  if (!Array.isArray(value)) throw httpError(400, "invalid_pi_model_scope");
  return [...new Set(value.map((model) => String(model || "").trim().slice(0, 512)).filter(Boolean))].slice(0, 512);
}

module.exports = {createPiModelsService, normalizeScopedModels};
