"use strict";

const {
  googleWorkspaceServiceCatalog,
} = require("./googleWorkspace.catalog");

function createGoogleWorkspaceApiService(dependencies = {}) {
  const connections = dependencies.connectionsService;
  const oauth = dependencies.oauthService;
  if (!connections || !oauth) throw new Error("Google Workspace API service requires connection and OAuth services.");

  return {
    listGoogleWorkspaceServices: () => googleWorkspaceServiceCatalog(),
    listGoogleConnections: (uid) => listGoogleConnections(uid, dependencies),
    getGoogleConnection: (uid, connectionId) => getGoogleConnection(uid, connectionId, dependencies),
    deleteGoogleConnection: (uid, connectionId) => deleteGoogleConnection(uid, connectionId, dependencies),
    startGoogleConnection: (uid, workspaceId, payload) => oauth.startGoogleConnection(uid, workspaceId, payload),
    completeGoogleConnection: (query) => oauth.completeGoogleConnection(query),
    getWorkspaceGoogleConnection: (uid, workspaceId) => getWorkspaceGoogleConnection(uid, workspaceId, dependencies),
    bindWorkspaceGoogleConnection: (uid, workspaceId, payload) =>
      connections.bindGoogleWorkspaceConnection(uid, workspaceId, payload),
    unbindWorkspaceGoogleConnection: (uid, workspaceId) =>
      connections.unbindGoogleWorkspaceConnection(uid, workspaceId),
  };
}

async function getGoogleConnection(uid, connectionId, dependencies) {
  const connection = await dependencies.connectionsService.getGoogleConnection(uid, connectionId);
  const workspaceUsage = await workspaceUsageFor(uid, connectionId, dependencies);
  return {connection, workspaceUsage};
}

async function listGoogleConnections(uid, dependencies) {
  const result = await dependencies.connectionsService.listGoogleConnections(uid);
  const connections = await Promise.all((result.connections || []).map(async (connection) => ({
    ...connection,
    workspaceUsage: await workspaceUsageFor(uid, connection.connectionId, dependencies),
  })));
  return {connections};
}

async function deleteGoogleConnection(uid, connectionId, dependencies) {
  try {
    await dependencies.oauthService.revokeGoogleConnection(uid, connectionId);
  } catch (error) {
    if (error.publicMessage !== "google_connection_not_found") throw error;
  }
  return dependencies.connectionsService.deleteGoogleConnection(uid, connectionId);
}

async function getWorkspaceGoogleConnection(uid, workspaceId, dependencies) {
  if (typeof dependencies.requireWorkspace === "function") {
    await dependencies.requireWorkspace(uid, workspaceId);
  }
  const binding = await dependencies.connectionsService.getGoogleWorkspaceBinding(uid, workspaceId);
  if (!binding) return {binding: null, connection: null, services: googleWorkspaceServiceCatalog()};
  const connection = await dependencies.connectionsService.getGoogleConnection(uid, binding.connectionId);
  return {binding, connection, services: googleWorkspaceServiceCatalog()};
}

async function workspaceUsageFor(uid, connectionId, dependencies) {
  if (!dependencies.db) return {count: 0, workspaces: []};
  const snapshot = await dependencies.db.collection("workspaces").where("ownerUid", "==", uid).get();
  const workspaces = snapshot.docs
      .map((doc) => ({id: doc.id, ...((doc.data && doc.data()) || {})}))
      .filter((workspace) => workspace.googleWorkspaceBinding &&
        workspace.googleWorkspaceBinding.connectionId === connectionId)
      .map((workspace) => ({
        id: workspace.id,
        name: workspace.name || workspace.id,
      }));
  return {count: workspaces.length, workspaces};
}

module.exports = {
  createGoogleWorkspaceApiService,
  getWorkspaceGoogleConnection,
  workspaceUsageFor,
};
