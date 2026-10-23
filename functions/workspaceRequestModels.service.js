"use strict";

const {httpError} = require("./backendUtils.helpers");

const MAX_MODEL_ID_LENGTH = 512;
const MAX_MODEL_NAME_LENGTH = 256;

function normalizeModelSelection(value, field = "model") {
  if (value === undefined || value === null || value === "") return null;
  if (!isPlainObject(value)) throw httpError(400, `invalid_workspace_request_${field}`);
  const keys = Object.keys(value);
  if (keys.some((key) => !["providerId", "modelId"].includes(key))) {
    throw httpError(400, `invalid_workspace_request_${field}`);
  }
  const providerId = clean(value.providerId, MAX_MODEL_ID_LENGTH);
  const modelId = clean(value.modelId, MAX_MODEL_ID_LENGTH);
  if (!providerId || !modelId) throw httpError(400, `invalid_workspace_request_${field}`);
  return {providerId, modelId};
}

function normalizeModelRequest(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") {
    const name = value.trim();
    if (!name || name.length > MAX_MODEL_NAME_LENGTH) throw httpError(400, "invalid_workspace_request_model");
    return {name};
  }
  if (!isPlainObject(value)) throw httpError(400, "invalid_workspace_request_model");
  const keys = Object.keys(value);
  if (keys.some((key) => !["providerId", "modelId", "name"].includes(key))) {
    throw httpError(400, "invalid_workspace_request_model");
  }
  if (value.name !== undefined && value.name !== null) {
    const name = clean(value.name, MAX_MODEL_NAME_LENGTH);
    if (!name) throw httpError(400, "invalid_workspace_request_model");
    const providerId = clean(value.providerId, MAX_MODEL_ID_LENGTH);
    return providerId ? {name, providerId} : {name};
  }
  return normalizeModelSelection(value, "model");
}

function normalizeModelCatalog(value) {
  if (!Array.isArray(value)) throw httpError(503, "workspace_request_model_discovery_unavailable");
  const seen = new Set();
  return value.flatMap((entry) => {
    if (!isPlainObject(entry)) return [];
    const providerId = clean(entry.providerId || entry.provider, MAX_MODEL_ID_LENGTH);
    const modelId = clean(entry.modelId || entry.id, MAX_MODEL_ID_LENGTH);
    if (!providerId || !modelId) return [];
    const key = `${providerId}/${modelId}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const name = clean(entry.name || entry.label || modelId, MAX_MODEL_NAME_LENGTH) || modelId;
    return [{
      providerId,
      modelId,
      name,
      available: entry.available !== false,
      ...(Array.isArray(entry.input) ? {input: entry.input.map(String).slice(0, 8)} : {}),
    }];
  });
}

function savedModelSelection(workspace = {}) {
  const candidates = [
    workspace.modelSelection,
    workspace.agentModelSelection,
    workspace.agentRuntimeSettings?.modelSelection,
    workspace.settings?.modelSelection,
    workspace.settings?.agent?.modelSelection,
    workspace.settings?.chat?.modelSelection,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return normalizeModelSelection(candidate, "saved_model_selection");
    } catch {
      return null;
    }
  }
  return null;
}

function resolveModelRequest(requestedValue, catalog, workspace = {}) {
  const requested = normalizeModelRequest(requestedValue);
  const normalizedCatalog = normalizeModelCatalog(catalog);
  if (!requested) {
    const saved = savedModelSelection(workspace);
    if (!saved) return {selection: null, source: "runtime_default", requested: null, catalog: normalizedCatalog};
    return resolveExact(saved, normalizedCatalog, "target_saved");
  }
  if (requested.providerId && requested.modelId) {
    return resolveExact(requested, normalizedCatalog, "explicit");
  }
  const query = requested.name.toLowerCase();
  const providerMatches = requested.providerId ? normalizedCatalog.filter((entry) => entry.providerId === requested.providerId) : normalizedCatalog;
  const matches = providerMatches.filter((entry) => [entry.name, entry.modelId, `${entry.providerId}/${entry.modelId}`]
      .some((value) => value.toLowerCase() === query));
  if (matches.length > 1) throw httpError(409, "workspace_request_model_ambiguous");
  if (!matches.length) throw httpError(409, "workspace_request_model_unavailable");
  return resolveExact(matches[0], normalizedCatalog, "friendly_name");
}

function resolveExact(selection, catalog, source) {
  const entry = catalog.find((candidate) => candidate.providerId === selection.providerId && candidate.modelId === selection.modelId);
  if (!entry) throw httpError(409, "workspace_request_model_unavailable");
  if (entry.available !== true) throw httpError(409, "workspace_request_provider_auth_required");
  return {
    selection: {providerId: entry.providerId, modelId: entry.modelId},
    source,
    requested: {providerId: selection.providerId, modelId: selection.modelId},
    catalog,
  };
}

function clean(value, maxLength) {
  if (value === undefined || value === null) return "";
  const result = String(value).trim();
  return result.length <= maxLength ? result : "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  normalizeModelCatalog,
  normalizeModelRequest,
  normalizeModelSelection,
  resolveModelRequest,
  savedModelSelection,
};
