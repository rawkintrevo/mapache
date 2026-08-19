"use strict";

const {httpError} = require("./backendUtils.helpers");
const {
  normalizeGoogleConnectionMetadata,
  normalizeGoogleConnectionSummary,
  normalizeGoogleWorkspaceBinding,
} = require("./googleWorkspace.models");

const CONNECTION_COLLECTION = "googleConnections";
const BINDING_FIELD = "googleWorkspaceBinding";

function createGoogleWorkspaceConnectionsService(dependencies = {}) {
  return {
    createGoogleConnection: (uid, metadata, encryptedCredentials) =>
      createGoogleConnection(uid, metadata, encryptedCredentials, dependencies),
    getGoogleConnection: (uid, connectionId, options) =>
      getGoogleConnection(uid, connectionId, options, dependencies),
    listGoogleConnections: (uid) => listGoogleConnections(uid, dependencies),
    updateGoogleConnection: (uid, connectionId, metadata, encryptedCredentials) =>
      updateGoogleConnection(uid, connectionId, metadata, encryptedCredentials, dependencies),
    deleteGoogleConnection: (uid, connectionId) => deleteGoogleConnection(uid, connectionId, dependencies),
    bindGoogleWorkspaceConnection: (uid, workspaceId, payload) =>
      bindGoogleWorkspaceConnection(uid, workspaceId, payload, dependencies),
    getGoogleWorkspaceBinding: (uid, workspaceId) =>
      getGoogleWorkspaceBinding(uid, workspaceId, dependencies),
    unbindGoogleWorkspaceConnection: (uid, workspaceId) =>
      unbindGoogleWorkspaceConnection(uid, workspaceId, dependencies),
  };
}

function connectionCollection(uid, dependencies) {
  if (!uid || typeof uid !== "string") throw httpError(400, "invalid_owner_uid");
  if (!dependencies.db) throw new Error("Google connection service requires a db dependency.");
  return dependencies.db.collection("users").doc(uid).collection("private").doc("googleConnections").collection("entries");
}

function connectionRef(uid, connectionId, dependencies) {
  return connectionCollection(uid, dependencies).doc(connectionId);
}

async function createGoogleConnection(uid, metadata, encryptedCredentials = null, dependencies = {}) {
  const normalized = normalizeStoredMetadata(metadata, dependencies);
  const ref = connectionRef(uid, normalized.connectionId, dependencies);
  const existing = await ref.get();
  if (existing.exists) throw httpError(409, "google_connection_exists");
  await ref.set({
    ownerUid: uid,
    ...normalized,
    encryptedCredentials: normalizeEncryptedCredentials(encryptedCredentials),
  });
  return publicConnectionSummary(await ref.get());
}

async function getGoogleConnection(uid, connectionId, options = {}, dependencies = {}) {
  const snap = await connectionRef(uid, cleanConnectionId(connectionId), dependencies).get();
  if (!snap.exists) throw httpError(404, "google_connection_not_found");
  const data = snap.data() || {};
  if (options.includePrivate === true) {
    return {
      metadata: publicConnectionMetadata(data),
      encryptedCredentials: data.encryptedCredentials || null,
    };
  }
  return publicConnectionSummary(snap);
}

async function listGoogleConnections(uid, dependencies = {}) {
  const snap = await connectionCollection(uid, dependencies).get();
  return {
    connections: snap.docs.map(publicConnectionSummary)
        .sort((left, right) => left.email.localeCompare(right.email)),
  };
}

async function updateGoogleConnection(uid, connectionId, metadata, encryptedCredentials, dependencies = {}) {
  const ref = connectionRef(uid, cleanConnectionId(connectionId), dependencies);
  const existing = await ref.get();
  if (!existing.exists) throw httpError(404, "google_connection_not_found");
  const current = existing.data() || {};
  const normalized = normalizeStoredMetadata({...current, ...metadata, connectionId: ref.id}, dependencies, current);
  const patch = {...normalized};
  if (encryptedCredentials !== undefined) patch.encryptedCredentials = normalizeEncryptedCredentials(encryptedCredentials);
  await ref.set(patch, {merge: true});
  return publicConnectionSummary(await ref.get());
}

async function deleteGoogleConnection(uid, connectionId, dependencies = {}) {
  const cleanId = cleanConnectionId(connectionId);
  const ref = connectionRef(uid, cleanId, dependencies);
  const existing = await ref.get();
  if (!existing.exists) throw httpError(404, "google_connection_not_found");
  const workspaceSnap = await dependencies.db.collection("workspaces").where("ownerUid", "==", uid).get();
  for (const workspaceDoc of workspaceSnap.docs) {
    const workspace = workspaceDoc.data() || {};
    if (workspace[BINDING_FIELD] && workspace[BINDING_FIELD].connectionId === cleanId) {
      await workspaceDoc.ref.update({[BINDING_FIELD]: null});
    }
  }
  await ref.delete();
  return {ok: true, connectionId: cleanId};
}

async function bindGoogleWorkspaceConnection(uid, workspaceId, payload, dependencies = {}) {
  const workspaceRef = workspaceRefFor(workspaceId, dependencies);
  const workspaceSnap = await workspaceRef.get();
  assertWorkspaceOwner(workspaceSnap, uid);
  const binding = normalizeGoogleWorkspaceBinding(payload);
  const connectionSnap = await connectionRef(uid, binding.connectionId, dependencies).get();
  if (!connectionSnap.exists) throw httpError(404, "google_connection_not_found");
  const connection = connectionSnap.data() || {};
  if (connection.status !== "connected") throw httpError(409, "google_connection_reconnect_required");
  const allowed = new Set(connection.enabledServices || []);
  if (binding.enabledServices.some((key) => !allowed.has(key))) {
    throw httpError(400, "google_service_not_enabled");
  }
  await workspaceRef.update({[BINDING_FIELD]: binding});
  return binding;
}

async function getGoogleWorkspaceBinding(uid, workspaceId, dependencies = {}) {
  const workspaceSnap = await workspaceRefFor(workspaceId, dependencies).get();
  assertWorkspaceOwner(workspaceSnap, uid);
  const data = workspaceSnap.data() || {};
  return data[BINDING_FIELD] ? normalizeGoogleWorkspaceBinding(data[BINDING_FIELD]) : null;
}

async function unbindGoogleWorkspaceConnection(uid, workspaceId, dependencies = {}) {
  const workspaceRef = workspaceRefFor(workspaceId, dependencies);
  const workspaceSnap = await workspaceRef.get();
  assertWorkspaceOwner(workspaceSnap, uid);
  await workspaceRef.update({[BINDING_FIELD]: null});
  return {ok: true, workspaceId};
}

function normalizeStoredMetadata(metadata, dependencies, current = {}) {
  const now = typeof dependencies.now === "function" ? dependencies.now() : new Date().toISOString();
  return normalizeGoogleConnectionMetadata({
    ...metadata,
    createdAt: metadata.createdAt || current.createdAt || now,
    updatedAt: now,
    lastRefreshedAt: metadata.lastRefreshedAt || current.lastRefreshedAt || null,
  });
}

function publicConnectionMetadata(data = {}) {
  return {
    connectionId: data.connectionId || data.id,
    googleSubject: data.googleSubject,
    email: data.email,
    displayName: data.displayName,
    grantedScopes: data.grantedScopes || [],
    enabledServices: data.enabledServices || [],
    oauthClientRef: data.oauthClientRef,
    status: data.status,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    lastRefreshedAt: data.lastRefreshedAt,
  };
}

function publicConnectionSummary(source) {
  const data = typeof source.data === "function" ? source.data() || {} : source || {};
  return normalizeGoogleConnectionSummary(publicConnectionMetadata(data));
}

function normalizeEncryptedCredentials(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw httpError(400, "invalid_google_encrypted_credentials");
  const serialized = JSON.stringify(value);
  if (serialized.length > 100000) throw httpError(400, "invalid_google_encrypted_credentials");
  return value;
}

function cleanConnectionId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw httpError(400, "invalid_google_connection_id");
  return id;
}

function workspaceRefFor(workspaceId, dependencies) {
  const id = String(workspaceId || "").trim();
  if (!id || !dependencies.db) throw httpError(400, "invalid_workspace");
  return dependencies.db.collection("workspaces").doc(id);
}

function assertWorkspaceOwner(snapshot, uid) {
  if (!snapshot.exists) throw httpError(404, "workspace_not_found");
  if ((snapshot.data() || {}).ownerUid !== uid) throw httpError(403, "workspace_forbidden");
}

module.exports = {
  BINDING_FIELD,
  CONNECTION_COLLECTION,
  createGoogleWorkspaceConnectionsService,
  normalizeEncryptedCredentials,
};
