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
    getWorkspaceGateway: (uid, workspaceId) => getWorkspaceGateway(uid, workspaceId, dependencies),
    listGateways: (uid) => listGateways(uid, dependencies),
    saveAssignments: (uid, gatewayId, payload) => saveAssignments(uid, gatewayId, payload, dependencies),
    setWorkspaceGateway: (uid, workspaceId, payload) => setWorkspaceGateway(uid, workspaceId, payload, dependencies),
  };
}

async function getWorkspaceGateway(uid, workspaceId, dependencies = {}) {
  const details = await readWorkspaceGatewayDetails(uid, workspaceId, dependencies);
  return serializeWorkspaceGatewayStatus(details);
}

async function setWorkspaceGateway(uid, workspaceId, payload = {}, dependencies = {}) {
  if (typeof payload.enabled !== "boolean") throw httpError(400, "browser_egress_enabled_required");
  const details = await readWorkspaceGatewayDetails(uid, workspaceId, dependencies);
  if (!details.config) throw httpError(409, "browser_egress_gateway_unavailable");

  let changed = false;
  if (payload.enabled) {
    if (details.assignedRoutes.length > 1) throw httpError(409, "browser_egress_ambiguous_route");
    if (!details.assignedRoutes.length) {
      if (details.enabledRoutes.length === 0) throw httpError(409, "browser_egress_gateway_unavailable");
      if (details.enabledRoutes.length > 1) throw httpError(409, "browser_egress_gateway_selection_required");
      const candidate = details.enabledRoutes[0];
      await writeAssignment(
          uid,
          candidate.route,
          [...candidate.workspaceIds, workspaceId],
          dependencies,
      );
      changed = true;
    }
  } else if (details.assignedRoutes.length) {
    for (const assigned of details.assignedRoutes) {
      await writeAssignment(
          uid,
          assigned.route,
          assigned.workspaceIds.filter((id) => id !== workspaceId),
          dependencies,
      );
    }
    changed = true;
  }

  const updated = await readWorkspaceGatewayDetails(uid, workspaceId, dependencies);
  return {...serializeWorkspaceGatewayStatus(updated), changed};
}

async function readWorkspaceGatewayDetails(uid, workspaceId, dependencies = {}) {
  const workspaces = await listOwnedWorkspaces(uid, dependencies);
  if (!workspaces.some((workspace) => workspace.id === workspaceId)) {
    throw httpError(404, "workspace_not_found");
  }
  const config = await readBrowserEgressConfig(dependencies);
  if (!config) return {config: null, enabledRoutes: [], assignedRoutes: []};

  const enabledRoutes = [];
  const assignedRoutes = [];
  const seenIds = new Set();
  for (const route of ownedRoutes(config.routes, uid)) {
    validateBrowserEgressRoute(route);
    const gatewayId = gatewayIdForRoute(route);
    if (seenIds.has(gatewayId)) throw httpError(409, "browser_egress_ambiguous_route");
    seenIds.add(gatewayId);
    const workspaceIds = await readBrowserEgressAssignment(uid, route, dependencies) || normalizeWorkspaceIds(route.workspaceIds);
    if (route.enabled !== true) continue;
    const candidate = {route, workspaceIds};
    enabledRoutes.push(candidate);
    if (workspaceIds.includes(workspaceId)) assignedRoutes.push(candidate);
  }
  return {config, enabledRoutes, assignedRoutes};
}

function serializeWorkspaceGatewayStatus({config, enabledRoutes, assignedRoutes}) {
  const assigned = assignedRoutes.length === 1 ? assignedRoutes[0] : null;
  const candidate = assigned || (enabledRoutes.length === 1 ? enabledRoutes[0] : null);
  return {
    configured: Boolean(config),
    enabled: Boolean(assigned),
    canEnable: !assignedRoutes.length && enabledRoutes.length === 1,
    ambiguous: assignedRoutes.length > 1,
    gateway: candidate ? serializeGatewaySummary(candidate.route) : null,
  };
}

function serializeGatewaySummary(route) {
  return {
    id: gatewayIdForRoute(route),
    host: route.host,
    port: route.port,
    user: route.user,
  };
}

async function writeAssignment(uid, route, workspaceIds, dependencies = {}) {
  const ref = browserEgressAssignmentRef(dependencies.db, uid, gatewayIdForRoute(route));
  if (!ref) throw httpError(503, "browser_egress_assignment_unavailable");
  const existing = await ref.get();
  const now = dependencies.admin.firestore.FieldValue.serverTimestamp();
  await ref.set({
    ownerUid: uid,
    gatewayId: gatewayIdForRoute(route),
    workspaceIds: normalizeWorkspaceIds(workspaceIds),
    updatedAt: now,
    ...(existing.exists ? {} : {createdAt: now}),
  }, {merge: true});
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
  getWorkspaceGateway,
  listGateways,
  saveAssignments,
  serializeGateway,
  setWorkspaceGateway,
};
