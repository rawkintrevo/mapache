"use strict";

const crypto = require("node:crypto");
const {auth, db: defaultDb} = require("./backendContext");

const SECRET_RESOURCE_PATTERN = /^projects\/[a-z0-9-]+\/secrets\/[A-Za-z0-9_-]+\/versions\/[1-9][0-9]*$/;
const GATEWAY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function browserEgressAssignmentRef(database, uid, gatewayId) {
  if (!database || !uid || !gatewayId) return null;
  return database.collection("users").doc(uid).collection("private")
      .doc("browserEgressAssignments").collection("gateways").doc(gatewayId);
}

function normalizeWorkspaceIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim())
      .filter((item) => item && item.length <= 256 && !item.includes("/")))];
}

function gatewayIdForRoute(route = {}) {
  const configuredId = String(route.id || "").trim();
  if (GATEWAY_ID_PATTERN.test(configuredId)) return configuredId;
  const fingerprint = [
    route.ownerUid || "",
    route.host || "",
    route.port || "",
    route.user || "",
    route.hostKey || "",
  ].join("\u0000");
  return `gateway-${crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 24)}`;
}

function validateBrowserEgressRoute(route = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(route.host || "") ||
      !/^[a-z_][a-z0-9_-]{0,31}$/.test(route.user || "") ||
      !Number.isInteger(route.port) || route.port < 1 || route.port > 65535 ||
      !/^ssh-ed25519 [A-Za-z0-9+/]+={0,3}$/.test(route.hostKey || "") ||
      !String(route.privateKey || "").startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n")) {
    throw new Error("browser_egress_invalid_route");
  }
  return route;
}

async function readBrowserEgressConfig(dependencies = {}) {
  const resource = dependencies.resource ?? process.env.BROWSER_EGRESS_CONFIG_SECRET;
  if (!resource) return null;
  if (!SECRET_RESOURCE_PATTERN.test(resource)) {
    throw new Error("browser_egress_invalid_secret_resource");
  }
  let config;
  try {
    const read = dependencies.readSecret || (async () => {
      const client = await auth.getClient();
      const response = await client.request({url: `https://secretmanager.googleapis.com/v1/${resource}:access`});
      return JSON.parse(Buffer.from(response.data.payload.data, "base64").toString("utf8"));
    });
    config = await read(resource);
  } catch {
    throw new Error("browser_egress_configuration_unavailable");
  }
  if (config?.version !== 1 || !Array.isArray(config.routes)) {
    throw new Error("browser_egress_invalid_configuration");
  }
  return config;
}

async function readBrowserEgressAssignment(uid, route, dependencies = {}) {
  const database = dependencies.db === undefined ? defaultDb : dependencies.db;
  const ref = browserEgressAssignmentRef(database, uid, gatewayIdForRoute(route));
  if (!ref) return null;
  let snapshot;
  try {
    snapshot = await ref.get();
  } catch {
    throw new Error("browser_egress_assignment_unavailable");
  }
  if (!snapshot.exists) return null;
  const data = snapshot.data() || {};
  if (data.ownerUid !== uid || data.gatewayId !== gatewayIdForRoute(route)) {
    throw new Error("browser_egress_invalid_assignment");
  }
  return normalizeWorkspaceIds(data.workspaceIds);
}

async function assignedWorkspaceIds(session, route, dependencies = {}) {
  const assignment = await readBrowserEgressAssignment(session.ownerUid, route, dependencies);
  return assignment || normalizeWorkspaceIds(route.workspaceIds);
}

async function workspaceBelongsToOwner(session, dependencies = {}) {
  if (!session?.ownerUid || !session?.workspaceId) return false;
  const database = dependencies.db === undefined ? defaultDb : dependencies.db;
  // Unit callers can explicitly disable Firestore. Production provisioning always
  // has the initialized database and therefore fails closed on ownership mismatch.
  if (!database) return true;
  try {
    const snapshot = await database.collection("workspaces").doc(session.workspaceId).get();
    return snapshot.exists && snapshot.data()?.ownerUid === session.ownerUid;
  } catch {
    throw new Error("browser_egress_workspace_unavailable");
  }
}

// Operator-only Secret Manager configuration, never a workspace/session field.
// Credentials remain operator-owned; user-editable assignments are stored
// separately in Firestore and only contain gateway/workspace metadata.
async function browserEgressEnvironment(session, dependencies = {}) {
  const config = await readBrowserEgressConfig(dependencies);
  if (!config) return [];
  if (!(await workspaceBelongsToOwner(session, dependencies))) return [];

  // Identity comes from server-owned provisioning state; client route hints are ignored.
  const routes = config.routes.filter((route) => route.ownerUid && route.ownerUid === session.ownerUid);
  const assignedRoutes = [];
  for (const route of routes) {
    if (route.enabled !== true) continue;
    validateBrowserEgressRoute(route);
    if ((await assignedWorkspaceIds(session, route, dependencies)).includes(session.workspaceId)) {
      assignedRoutes.push(route);
    }
  }
  if (!assignedRoutes.length) return [];
  if (assignedRoutes.length !== 1) throw new Error("browser_egress_ambiguous_route");
  const route = assignedRoutes[0];
  return [{name: "MAPACHE_BROWSER_SSH_EGRESS", value: JSON.stringify({
    host: route.host, port: route.port, user: route.user,
    hostKey: route.hostKey, privateKey: route.privateKey,
  })}];
}

module.exports = {
  browserEgressAssignmentRef,
  browserEgressEnvironment,
  gatewayIdForRoute,
  normalizeWorkspaceIds,
  readBrowserEgressAssignment,
  readBrowserEgressConfig,
  validateBrowserEgressRoute,
};
