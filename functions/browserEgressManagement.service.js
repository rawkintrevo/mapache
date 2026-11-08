"use strict";

const {httpError} = require("./backendUtils.helpers");
const {
  browserEgressAssignmentRef,
  gatewayIdForRoute,
  normalizeWorkspaceIds,
  readBrowserEgressAssignment,
  readBrowserEgressConfig,
  validateBrowserEgressRoute,
} = require("./browserEgress.service");

const MAX_GATEWAY_WORKSPACES = 100;

function createBrowserEgressManagementService(dependencies = {}) {
  return {
    listGateways: (uid) => listGateways(uid, dependencies),
    saveAssignments: (uid, gatewayId, payload) => saveAssignments(uid, gatewayId, payload, dependencies),
  };
}

async function listGateways(uid, dependencies = {}) {
  const config = await readBrowserEgressConfig(dependencies);
  if (!config) return {gateways: [], workspaces: []};
  const workspaces = await listOwnedWorkspaces(uid, dependencies);
  const workspaceMap = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const routes = ownedRoutes(config.routes, uid);
  const seenIds = new Set();
  const gateways = [];
  for (const route of routes) {
    validateBrowserEgressRoute(route);
    const id = gatewayIdForRoute(route);
    if (seenIds.has(id)) throw httpError(409, "browser_egress_ambiguous_route");
    seenIds.add(id);
    const assignment = await readBrowserEgressAssignment(uid, route, dependencies);
    const workspaceIds = visibleWorkspaceIds(assignment || normalizeWorkspaceIds(route.workspaceIds), workspaceMap);
    gateways.push(serializeGateway(route, workspaceIds, workspaceMap));
  }
  return {
    gateways: gateways.sort((left, right) => `${left.host}:${left.port}`.localeCompare(`${right.host}:${right.port}`)),
    workspaces: workspaces.map(({id, name}) => ({id, name})).sort((left, right) => left.name.localeCompare(right.name)),
  };
}

async function saveAssignments(uid, gatewayId, payload = {}, dependencies = {}) {
  const config = await readBrowserEgressConfig(dependencies);
  const route = ownedRoutes(config?.routes || [], uid).find((candidate) => gatewayIdForRoute(candidate) === String(gatewayId || "").trim());
  if (!route) throw httpError(404, "browser_egress_gateway_not_found");
  validateBrowserEgressRoute(route);
  if (route.enabled !== true) throw httpError(409, "browser_egress_gateway_disabled");
  if (!Array.isArray(payload.workspaceIds)) throw httpError(400, "browser_egress_workspace_ids_required");
  const workspaceIds = normalizeWorkspaceIds(payload.workspaceIds);
  if (workspaceIds.length > MAX_GATEWAY_WORKSPACES) throw httpError(400, "too_many_browser_egress_workspaces");

  const workspaces = await listOwnedWorkspaces(uid, dependencies);
  const workspaceMap = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  if (workspaceIds.some((workspaceId) => !workspaceMap.has(workspaceId))) {
    throw httpError(403, "workspace_forbidden");
  }

  const ref = browserEgressAssignmentRef(dependencies.db, uid, gatewayIdForRoute(route));
  if (!ref) throw httpError(503, "browser_egress_assignment_unavailable");
  const existing = await ref.get();
  const now = dependencies.admin.firestore.FieldValue.serverTimestamp();
  await ref.set({
    ownerUid: uid,
    gatewayId: gatewayIdForRoute(route),
    workspaceIds,
    updatedAt: now,
    ...(existing.exists ? {} : {createdAt: now}),
  }, {merge: true});
  return serializeGateway(route, workspaceIds, workspaceMap);
}

function ownedRoutes(routes, uid) {
  return Array.isArray(routes) ? routes.filter((route) => route && route.ownerUid === uid) : [];
}

async function listOwnedWorkspaces(uid, dependencies = {}) {
  if (!dependencies.db) throw httpError(503, "browser_egress_assignment_unavailable");
  const snapshot = await dependencies.db.collection("workspaces").where("ownerUid", "==", uid).get();
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    name: String(doc.data()?.name || doc.id),
  }));
}

function visibleWorkspaceIds(ids, workspaceMap) {
  return normalizeWorkspaceIds(ids).filter((workspaceId) => workspaceMap.has(workspaceId));
}

function serializeGateway(route, workspaceIds, workspaceMap) {
  const visibleIds = visibleWorkspaceIds(workspaceIds, workspaceMap);
  return {
    id: gatewayIdForRoute(route),
    host: route.host,
    port: route.port,
    user: route.user,
    enabled: route.enabled === true,
    workspaceIds: visibleIds,
    workspaces: visibleIds.map((id) => ({id, name: workspaceMap.get(id).name})),
  };
}

module.exports = {
  MAX_GATEWAY_WORKSPACES,
  createBrowserEgressManagementService,
  listGateways,
  saveAssignments,
  serializeGateway,
};
