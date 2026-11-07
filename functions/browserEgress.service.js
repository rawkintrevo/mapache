"use strict";

const {auth} = require("./backendContext");

// Operator-only Secret Manager configuration, never a workspace/session field.
// Leave unset until the deployment's runner isolation has been reviewed.
async function browserEgressEnvironment(session, dependencies = {}) {
  const resource = dependencies.resource ?? process.env.BROWSER_EGRESS_CONFIG_SECRET;
  if (!resource) return [];
  if (!/^projects\/[a-z0-9-]+\/secrets\/[A-Za-z0-9_-]+\/versions\/[1-9][0-9]*$/.test(resource)) {
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
  if (config?.version !== 1 || !Array.isArray(config.routes)) throw new Error("browser_egress_invalid_configuration");
  // Identity comes from server-owned provisioning state; client route hints are ignored.
  const routes = config.routes.filter((route) => route.ownerUid && route.ownerUid === session.ownerUid &&
    Array.isArray(route.workspaceIds) && route.workspaceIds.includes(session.workspaceId));
  if (!routes.length) return [];
  if (routes.length !== 1) throw new Error("browser_egress_ambiguous_route");
  const route = routes[0];
  if (route.enabled !== true) return [];
  if (route.isolationReviewed !== true) throw new Error("browser_egress_isolation_review_required");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(route.host || "") ||
      !/^[a-z_][a-z0-9_-]{0,31}$/.test(route.user || "") ||
      !Number.isInteger(route.port) || route.port < 1 || route.port > 65535 ||
      !/^ssh-ed25519 [A-Za-z0-9+/]+={0,3}$/.test(route.hostKey || "") ||
      !String(route.privateKey || "").startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n")) {
    throw new Error("browser_egress_invalid_route");
  }
  return [{name: "MAPACHE_BROWSER_SSH_EGRESS", value: JSON.stringify({
    host: route.host, port: route.port, user: route.user,
    hostKey: route.hostKey, privateKey: route.privateKey,
  })}];
}

module.exports = {browserEgressEnvironment};
