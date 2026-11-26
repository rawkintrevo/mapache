"use strict";

const crypto = require("node:crypto");
const {httpError} = require("./backendUtils.helpers");
const {normalizeEnvironmentEntryIds} = require("./environmentKeys.service");
const {isRemoteLibvirtRuntime, normalizeRuntimeDescriptor} = require("./runtimeProvider.helpers");
const {
  normalizePiAuthEntries,
  normalizePiAuthProviders,
  normalizePiAuthSelection,
} = require("./agentAuth.service");

const TOKEN_AUDIENCE = "remote-credentials";
const TOKEN_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 30 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * Server-side connection materialization for a remote-libvirt guest.
 *
 * The guest authenticates with a short-lived HMAC token signed by the
 * session's browser-access secret. The response contains only the owner's
 * selected agent/environment/MCP material. Host SSH keys, Firebase service
 * accounts, refresh tokens, and another owner's records never cross this
 * boundary.
 */
function createRemoteVmCredentialsService(dependencies = {}) {
  if (!dependencies.db || typeof dependencies.db.collection !== "function") {
    throw new Error("remote_vm_credentials_db_required");
  }
  return Object.freeze({
    resolve: (request) => resolve(request, dependencies),
    signToken: (session, workspaceId, ownerUid, expiresAt) => signToken({
      bootId: session?.agentRuntimeBootInstanceId || session?.runtimeProvider?.bootId || "",
      expiresAt,
      generation: session?.agentRuntimeGeneration || session?.runtimeProvider?.generation,
      ownerUid,
      sessionId: session?.runnerSessionId || session?.id,
      secret: session?.browserAccessTokenSecret,
      workspaceId,
      issuedAt: dependencies.now,
    }),
  });
}

async function resolve(request = {}, dependencies = {}) {
  if (String(request.method || "").toUpperCase() !== "POST") throw httpError(405, "method_not_allowed");
  const body = request.body && typeof request.body === "object" ? request.body : {};
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) throw httpError(413, "request_too_large");
  const token = readBearerToken(request);
  const payload = parseTokenPayload(token);
  if (!payload || !ID_PATTERN.test(String(payload.wid || "")) || !ID_PATTERN.test(String(payload.sid || ""))) {
    throw unauthorized();
  }

  const now = currentMillis(dependencies);
  const workspaceRef = dependencies.db.collection("workspaces").doc(String(payload.wid));
  const sessionRef = workspaceRef.collection("sessions").doc(String(payload.sid));
  const [workspaceSnap, sessionSnap] = await Promise.all([workspaceRef.get(), sessionRef.get()]);
  if (!workspaceSnap.exists || !sessionSnap.exists) throw unauthorized();
  const workspace = workspaceSnap.data() || {};
  const session = {id: String(payload.sid), ...(sessionSnap.data() || {})};
  const ownerUid = String(workspace.ownerUid || "");
  if (!ownerUid || ownerUid !== String(payload.uid || "") || session.ownerUid !== ownerUid ||
      session.workspaceId && session.workspaceId !== String(payload.wid) ||
      workspace.deleted === true || isDeletedLifecycle(workspace.lifecycle || workspace.status) ||
      session.deletedAt || String(session.status || "").toLowerCase() !== "running") {
    throw unauthorized();
  }
  let descriptor;
  try {
    descriptor = normalizeRuntimeDescriptor(session.runtimeProvider || workspace.runtimeProvider, {
      ownerUid,
      workspaceId: String(payload.wid),
    });
  } catch {
    throw unauthorized();
  }
  if (!isRemoteLibvirtRuntime(descriptor) || descriptor.state !== "running" ||
      String(payload.gen || "") !== String(descriptor.generation)) throw unauthorized();
  if (payload.boot && String(payload.boot) !== String(
      session.agentRuntimeBootInstanceId || session.runtimeProvider?.bootId || descriptor.bootId || "",
  )) {
    throw unauthorized();
  }
  if (!verifyToken(token, session.browserAccessTokenSecret, payload, now)) throw unauthorized();

  const piAuth = await resolvePiAuth(ownerUid, session, dependencies);
  const environmentEntryIds = normalizeEnvironmentEntryIds(
      session.environmentEntryIds || session.genericEnvironmentEntryIds || [],
  );
  const environment = dependencies.environmentKeysService?.resolveGenericEnvironment ?
    await dependencies.environmentKeysService.resolveGenericEnvironment(ownerUid, environmentEntryIds) : {};
  const google = dependencies.googleWorkspaceProvisioningService?.resolveGoogleMcpRuntime ?
    await dependencies.googleWorkspaceProvisioningService.resolveGoogleMcpRuntime(
        ownerUid,
        String(payload.wid),
        session.mcpConfig || {},
    ) : {mcpConfig: session.mcpConfig || {mcpServers: {}}, env: {}};
  const expiresAt = Math.min(now + TOKEN_TTL_MS, Number(payload.exp) * 1000);
  return {
    ok: true,
    expiresAt: new Date(expiresAt).toISOString(),
    generation: descriptor.generation,
    auth: piAuth,
    environment: {...environment, ...(google.env || {})},
    mcpConfig: google.mcpConfig || {mcpServers: {}},
  };
}

async function resolvePiAuth(ownerUid, session, dependencies) {
  if (typeof dependencies.agentAuthService?.getPiAuth !== "function") {
    return {providers: {}, entries: {}};
  }
  const current = await dependencies.agentAuthService.getPiAuth(ownerUid);
  const providers = normalizePiAuthProviders(current.providers);
  const entries = normalizePiAuthEntries(current.entries, providers);
  const selection = session.authSelection && typeof session.authSelection === "object" ?
    session.authSelection : null;
  if (!selection || selection.harness !== "pi") return {providers, entries};
  const selected = normalizePiAuthSelection(selection.providers, entries);
  const selectedEntries = Object.fromEntries(Object.values(selected).map((entryId) => [entryId, entries[entryId]]));
  const selectedProviders = Object.fromEntries(Object.entries(selected).map(([provider, entryId]) => [
    provider,
    entries[entryId]?.credential,
  ]).filter(([, credential]) => credential));
  return {providers: selectedProviders, entries: selectedEntries};
}

function signToken({secret, workspaceId, ownerUid, sessionId, generation, bootId, expiresAt, issuedAt} = {}) {
  const value = String(secret || "");
  if (!value) throw httpError(503, "remote_credentials_unavailable");
  const exp = Math.floor(Number(expiresAt || Date.now() + TOKEN_TTL_MS) / 1000);
  const issuedAtMillis = typeof issuedAt === "function" ? currentMillis({now: issuedAt}) : Date.now();
  const payload = encode({
    aud: TOKEN_AUDIENCE,
    boot: String(bootId || ""),
    exp,
    gen: String(generation || ""),
    iat: Math.floor(issuedAtMillis / 1000),
    sid: String(sessionId || ""),
    uid: String(ownerUid || ""),
    wid: String(workspaceId || ""),
  });
  return `${payload}.${hmac(payload, value)}`;
}

function verifyToken(token, secret, payload, now = Date.now()) {
  if (!secret || !payload || payload.aud !== TOKEN_AUDIENCE ||
      !Number.isSafeInteger(Number(payload.iat)) || !Number.isSafeInteger(Number(payload.exp)) ||
      Number(payload.iat) * 1000 > now + CLOCK_SKEW_MS || Number(payload.exp) * 1000 <= now ||
      Number(payload.exp) * 1000 - Number(payload.iat) * 1000 > TOKEN_TTL_MS + CLOCK_SKEW_MS) return false;
  const parts = String(token || "").split(".");
  return parts.length === 2 && safeEqual(parts[1], hmac(parts[0], secret));
}

function parseTokenPayload(token) {
  const part = String(token || "").split(".")[0];
  if (!part || part.length > 8192) return null;
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function readBearerToken(request) {
  const value = typeof request.get === "function" ? request.get("authorization") : request.headers?.authorization;
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(value || ""));
  if (!match) throw unauthorized();
  return match[1];
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function hmac(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function currentMillis(dependencies) {
  const value = typeof dependencies.now === "function" ? dependencies.now() : Date.now();
  const millis = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(millis) ? millis : Date.now();
}

function isDeletedLifecycle(value) {
  return ["deleting", "deleted"].includes(String(value || "").trim().toLowerCase());
}

function unauthorized() {
  return httpError(404, "not_found");
}

module.exports = {
  CLOCK_SKEW_MS,
  TOKEN_AUDIENCE,
  TOKEN_TTL_MS,
  createRemoteVmCredentialsService,
  parseTokenPayload,
  signToken,
  verifyToken,
};
