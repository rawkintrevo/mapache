"use strict";

const {createHmac, timingSafeEqual} = require("node:crypto");
const {httpError} = require("./backendUtils.helpers");
const {sshPrivateKey} = require("./remoteHost.connection");
const {normalizeHostAddress, resolveAllowedAddresses} = require("./remoteHost.service");
const {isRemoteLibvirtRuntime, normalizeRuntimeDescriptor} = require("./runtimeProvider.helpers");

const DEFAULT_AGENT_PORT = 8787;
const ROUTE_TTL_MS = 10_000;
const MAX_BODY_BYTES = 16 * 1024;
const HOST_PATTERN = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const PATH_PATTERN = /^\/(?:agent(?:\/|$)|runner\/health(?:\/)?$)/;

/**
 * Resolve a browser gateway request into a backend-owned target.
 *
 * The function is IAM-invoked by vm-gateway only.  `privateKey` is therefore
 * returned over the server-to-server call and is never placed in a browser
 * response, URL, Firestore route record, or log.  The gateway uses it only to
 * open an SSH stdio relay to the guest's fixed pi-web-ui port.
 */
function createVmGatewayResolveService({db, now = Date.now, allowedGatewayHosts, resolveHost} = {}) {
  if (!db || typeof db.collection !== "function") throw new Error("vm_gateway_resolver_db_required");

  return async function resolve(req = {}) {
    if (String(req.method || "").toUpperCase() !== "POST") throw httpError(405, "method_not_allowed");
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) throw httpError(413, "request_too_large");

    const host = normalizeGatewayHost(body.host);
    if (!gatewayHostAllowed(host, allowedGatewayHosts)) throw httpError(404, "not_found");
    const requestPath = normalizeRequestPath(body.path);
    const origin = normalizeOptionalOrigin(body.origin);
    if (origin && origin !== `https://${host}`) throw httpError(404, "not_found");

    const time = Number(now());
    if (!Number.isSafeInteger(time)) throw httpError(503, "gateway_unavailable");

    const payload = parseTokenPayload(body.token);
    // Workspace-scoped tokens select remote-libvirt before consulting the
    // hostname-scoped Compute Engine route. Both providers share this gateway
    // hostname; an existing Compute route must not shadow remote workspaces.
    // This is only dispatch: the selected branch still verifies the signature,
    // owner and generation. A failed remote token never falls back to Compute.
    if (!payload || !Object.prototype.hasOwnProperty.call(payload, "wid")) {
      const legacy = await resolveLegacyComputeRoute({db, host, requestPath, body, time});
      if (legacy) return legacy;
      throw httpError(404, "not_found");
    }
    if (!payload || !payload.wid || !payload.sid) throw httpError(404, "not_found");
    const workspaceRef = db.collection("workspaces").doc(String(payload.wid));
    const sessionRef = workspaceRef.collection("sessions").doc(String(payload.sid));
    const hostRef = db.collection("remoteHosts");
    const route = await db.runTransaction(async (transaction) => {
      const [workspaceSnap, sessionSnap] = await Promise.all([
        transaction.get(workspaceRef),
        transaction.get(sessionRef),
      ]);
      if (!workspaceSnap.exists || !sessionSnap.exists) throw httpError(404, "not_found");
      const workspace = workspaceSnap.data() || {};
      const session = sessionSnap.data() || {};
      const descriptor = normalizeRemoteDescriptor(workspace, session, payload);
      if (!descriptor || !verifyBrowserToken(body.token, session.browserAccessTokenSecret, payload, time)) {
        throw httpError(404, "not_found");
      }
      if (!PATH_PATTERN.test(new URL(requestPath, "https://gateway.invalid").pathname)) throw httpError(404, "not_found");
      if (requestPath === "/runner/health" || requestPath === "/runner/health/") {
        if (!safeEqual(body.shutdownToken, session.shutdownToken)) throw httpError(404, "not_found");
      } else if (payload.aud !== "agent" || String(payload.gen) !== String(descriptor.generation)) {
        throw httpError(404, "not_found");
      }
      if (workspace.ownerUid !== session.ownerUid || workspace.ownerUid !== payload.uid && payload.uid) {
        throw httpError(404, "not_found");
      }
      const remoteHostSnap = await transaction.get(hostRef.doc(descriptor.hostId));
      const remoteHost = remoteHostSnap.data() || {};
      if (!remoteHostSnap.exists || remoteHost.ownerUid !== workspace.ownerUid ||
          remoteHost.status !== "ready" || remoteHost.ready !== true || remoteHost.deletedAt ||
          !remoteHost.hostKeyFingerprint) throw httpError(404, "not_found");
      const privateSnap = await transaction.get(privateHostRef(workspace.ownerUid, descriptor.hostId, db));
      const privateData = privateSnap.data() || {};
      if (!privateSnap.exists || typeof privateData.privateKey !== "string" || !privateData.privateKey) {
        throw httpError(404, "not_found");
      }
      const guestAddress = normalizeGuestAddress(descriptor.guestIp);
      return {
        transport: "ssh",
        sshAddress: remoteHost.address,
        sshPort: normalizePort(remoteHost.port || 22),
        sshUsername: normalizeUsername(remoteHost.managedUsername),
        hostKeyFingerprint: remoteHost.hostKeyFingerprint,
        privateKey: sshPrivateKey(privateData.privateKey),
        guestAddress,
        guestPort: DEFAULT_AGENT_PORT,
        sessionId: String(session.runnerSessionId || payload.sid),
        generation: descriptor.generation,
        bootId: String(session.agentRuntimeBootInstanceId),
        validUntil: Math.min(time + ROUTE_TTL_MS, payload.exp * 1000),
      };
    });
    const addresses = await resolveAllowedAddresses(normalizeHostAddress(route.sshAddress), {resolveHost});
    return {...route, sshAddress: addresses[0]};
  };
}

async function resolveLegacyComputeRoute({db, host, requestPath, body, time}) {
  const routeSnap = await db.collection("vmGatewayRoutes_v2").doc(host).get().catch(() => ({exists: false}));
  if (!routeSnap.exists) return null;
  const route = routeSnap.data() || {};
  if (!route.workspaceId || route.enabled !== true) throw httpError(404, "not_found");
  const workspaceSnap = await db.collection("vmRuntimes_v2").doc(route.workspaceId).get();
  const workspace = workspaceSnap.data() || {};
  if (!workspaceSnap.exists || workspace.backend !== "compute-engine" || !workspace.currentSessionId) {
    throw httpError(404, "not_found");
  }
  const runtimeRef = db.collection("vmRuntimes_v2").doc(route.workspaceId);
  const [sessionSnap, credentialsSnap] = await Promise.all([
    runtimeRef.collection("sessions").doc(workspace.currentSessionId).get(),
    db.collection("vmRuntimeCredentials_v2").doc(workspace.currentSessionId).get(),
  ]);
  const session = sessionSnap.data();
  const credentials = credentialsSnap.data();
  if (!session || !credentials || route.ownerUid !== workspace.ownerUid ||
      session.ownerUid !== workspace.ownerUid || credentials.ownerUid !== workspace.ownerUid ||
      route.generation !== workspace.generation || session.generation !== workspace.generation ||
      credentials.generation !== workspace.generation || route.sessionId !== workspace.currentSessionId ||
      workspace.state !== "active" || session.state !== "active" ||
      !(workspace.leaseExpiresAt > time) || !(session.leaseExpiresAt > time)) throw httpError(404, "not_found");
  if (requestPath === "/runner/health" || requestPath === "/runner/health/") {
    if (!safeEqual(body.shutdownToken, credentials.shutdownToken)) throw httpError(404, "not_found");
  } else if (!verifyBrowserToken(body.token, credentials.browserToken, parseTokenPayload(body.token), time)) {
    throw httpError(404, "not_found");
  }
  if (!isComputeAddress(route.address)) throw httpError(503, "gateway_target_unavailable");
  return {
    transport: "direct",
    address: route.address,
    port: 8080,
    sessionId: workspace.currentSessionId,
    generation: workspace.generation,
    bootId: workspace.bootId || session.bootId,
    validUntil: Math.min(time + ROUTE_TTL_MS, requestPath.startsWith("/runner/health") ? time + 30_000 : tokenExpiry(body.token)),
  };
}

function normalizeRemoteDescriptor(workspace, session, payload) {
  if (workspace.deletedAt || session.deletedAt || session.status !== "running") return null;
  if (!session.agentRuntimeBootInstanceId || payload.boot !== session.agentRuntimeBootInstanceId) return null;
  let descriptor;
  try {
    descriptor = normalizeRuntimeDescriptor(session.runtimeProvider || workspace.runtimeProvider, {
      workspaceId: payload.wid,
      ownerUid: workspace.ownerUid,
    });
  } catch {
    return null;
  }
  if (!isRemoteLibvirtRuntime(descriptor) || descriptor.state !== "running" || !descriptor.guestIp) return null;
  if (String(payload.sid) !== String(session.id || session.runnerSessionId || payload.sid) &&
      String(payload.sid) !== String(session.runnerSessionId || "")) return null;
  if (String(payload.gen) !== String(descriptor.generation)) return null;
  return descriptor;
}

function verifyBrowserToken(token, secret, payload, time) {
  if (!payload || !secret || !Number.isSafeInteger(payload.exp) || payload.exp * 1000 <= time) return false;
  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !safeEqual(parts[1], createHmac("sha256", secret).update(parts[0]).digest("base64url"))) return false;
  return true;
}

function parseTokenPayload(token) {
  const part = String(token || "").split(".")[0];
  if (!part || part.length > 8192) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

function tokenExpiry(token) {
  const payload = parseTokenPayload(token);
  return payload && Number.isSafeInteger(payload.exp) ? payload.exp * 1000 : 0;
}

function normalizeGatewayHost(value) {
  const host = String(value || "").trim().toLowerCase().replace(/:\d+$/, "");
  if (!HOST_PATTERN.test(host)) throw httpError(400, "invalid_gateway_request");
  return host;
}

function gatewayHostAllowed(host, allowed) {
  const configured = typeof allowed === "function" ? allowed() : allowed;
  const hosts = String(configured || process.env.VM_WORKSPACE_GATEWAY_HOSTS || "")
      .split(",").map((item) => item.trim().toLowerCase().replace(/:\d+$/, ""))
      .filter(Boolean);
  return !hosts.length || hosts.includes(host);
}

function normalizeRequestPath(value) {
  if (typeof value !== "string" || value.length > 4096 || !value.startsWith("/") || value.startsWith("//") ||
      value.includes("\\") || /[\x00-\x20\x7f]/.test(value)) throw httpError(400, "invalid_gateway_request");
  let parsed;
  try { parsed = new URL(value, "https://gateway.invalid"); } catch { throw httpError(400, "invalid_gateway_request"); }
  let decodedPath;
  try { decodedPath = decodeURIComponent(parsed.pathname); } catch { throw httpError(400, "invalid_gateway_request"); }
  if (parsed.origin !== "https://gateway.invalid" || parsed.pathname.includes("..") || decodedPath.includes("..")) {
    throw httpError(404, "not_found");
  }
  return `${parsed.pathname}${parsed.search}`;
}

function normalizeOptionalOrigin(value) {
  if (value == null || value === "") return "";
  try { return new URL(String(value)).origin; } catch { throw httpError(400, "invalid_gateway_request"); }
}

function normalizeGuestAddress(value) {
  const address = String(value || "");
  if (!/^192\.168\.250\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/.test(address)) {
    throw httpError(503, "gateway_target_unavailable");
  }
  return address;
}

function isComputeAddress(value) {
  return /^10\.90\.0\.(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/.test(String(value || ""));
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw httpError(404, "not_found");
  return port;
}

function normalizeUsername(value) {
  const username = String(value || "");
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(username)) throw httpError(404, "not_found");
  return username;
}

function safeEqual(value, expected) {
  if (typeof value !== "string" || typeof expected !== "string" || value.length > 8192) return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function privateHostRef(uid, hostId, db) {
  return db.collection("users").doc(uid).collection("private")
      .doc("remoteHosts").collection("entries").doc(hostId);
}

module.exports = {
  createVmGatewayResolveService,
  gatewayHostAllowed,
  isComputeAddress,
  normalizeGuestAddress,
  normalizeRequestPath,
  parseTokenPayload,
};
