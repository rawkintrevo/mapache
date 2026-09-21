"use strict";

const crypto = require("node:crypto");

const {db: defaultDb} = require("./backendContext");
const {httpError} = require("./backendUtils.helpers");

const TOKEN_AUDIENCE = "automation-api";
const TOKEN_ISSUER = "mapache";
const TOKEN_TTL_SECONDS = 5 * 60;
const CLOCK_SKEW_SECONDS = 30;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function createAutomationAgentAuthService(dependencies = {}) {
  if (typeof dependencies.sessionCollection !== "function") {
    throw new Error("Automation agent auth requires a session collection factory.");
  }
  return {
    mintToken: (request) => mintToken(request, dependencies),
    verifyToken: (token) => verifyToken(token, dependencies),
  };
}

async function mintToken(request = {}, dependencies = {}) {
  if (String(request.method || "").toUpperCase() !== "POST") {
    throw httpError(405, "method_not_allowed");
  }
  const workspaceId = cleanId(request.body?.workspaceId);
  const sessionId = cleanId(request.body?.sessionId);
  const presentedToken = request.get?.("x-shutdown-token") || request.headers?.["x-shutdown-token"];
  const sessionSnap = await dependencies.sessionCollection(workspaceId).doc(sessionId).get();
  const session = sessionSnap.exists ? sessionSnap.data() || {} : null;
  if (!session || !safeTokenEqual(presentedToken, session.shutdownToken)) {
    throw unauthorized();
  }

  const workspaceSnap = await (dependencies.db || defaultDb).collection("workspaces").doc(workspaceId).get();
  const workspace = workspaceSnap.exists ? workspaceSnap.data() || {} : null;
  const generation = cleanGeneration(session.agentRuntimeGeneration);
  const bootInstanceId = cleanId(session.agentRuntimeBootInstanceId);
  if (!workspace || workspace.ownerUid !== session.ownerUid ||
      !session.ownerUid || session.workspaceId !== workspaceId ||
      session.runtimeKind !== "automation" || !isLiveSession(session) ||
      session.agentRuntimeAuthorityState !== "admitted" ||
      session.agentRuntimeSessionId !== sessionId || !generation || !bootInstanceId ||
      workspace.deleted === true || isDeletedLifecycle(workspace.lifecycle || workspace.status)) {
    throw unauthorized();
  }

  const nowSeconds = currentSeconds(dependencies);
  const claims = {
    iss: TOKEN_ISSUER,
    aud: TOKEN_AUDIENCE,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_TTL_SECONDS,
    ownerUid: String(session.ownerUid),
    workspaceId,
    sessionId,
    generation,
    bootInstanceId,
  };
  return {accessToken: signClaims(claims, requireSecret(dependencies)), expiresIn: TOKEN_TTL_SECONDS};
}

function verifyToken(token, dependencies = {}) {
  const value = String(token || "").trim();
  const parts = value.split(".");
  if (parts.length !== 3) throw unauthorized();
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  const secret = requireSecret(dependencies);
  const expectedSignature = hmac(`${encodedHeader}.${encodedClaims}`, secret);
  if (!safeTokenEqual(encodedSignature, expectedSignature)) throw unauthorized();

  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8"));
  } catch (error) {
    throw unauthorized(error);
  }
  const now = currentSeconds(dependencies);
  if (!header || header.alg !== "HS256" || header.typ !== "MAPACHE" ||
      !claims || claims.iss !== TOKEN_ISSUER || claims.aud !== TOKEN_AUDIENCE ||
      !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
      claims.iat > now + CLOCK_SKEW_SECONDS || claims.exp <= now ||
      claims.exp - claims.iat > TOKEN_TTL_SECONDS + CLOCK_SKEW_SECONDS ||
      !ID.test(String(claims.ownerUid || "")) || !ID.test(String(claims.workspaceId || "")) ||
      !ID.test(String(claims.sessionId || "")) || !ID.test(String(claims.bootInstanceId || "")) ||
      !cleanGeneration(claims.generation)) {
    throw unauthorized();
  }
  return {
    ...claims,
    generation: cleanGeneration(claims.generation),
    ownerUid: String(claims.ownerUid),
    workspaceId: String(claims.workspaceId),
    sessionId: String(claims.sessionId),
    bootInstanceId: String(claims.bootInstanceId),
  };
}

function signClaims(claims, secret) {
  const header = encode({alg: "HS256", typ: "MAPACHE"});
  const body = encode(claims);
  return `${header}.${body}.${hmac(`${header}.${body}`, secret)}`;
}

function requireSecret(dependencies) {
  const secret = typeof dependencies.secret === "function" ? dependencies.secret() : dependencies.secret;
  const value = String(secret || "");
  if (!value) throw httpError(503, "automation_agent_unavailable");
  return value;
}

function currentSeconds(dependencies) {
  const value = typeof dependencies.now === "function" ? dependencies.now() : Date.now();
  const millis = value instanceof Date ? value.getTime() : Number(value);
  return Math.floor((Number.isFinite(millis) ? millis : Date.now()) / 1000);
}

function hmac(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function safeTokenEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cleanId(value) {
  const id = String(value || "").trim();
  if (!ID.test(id)) throw httpError(400, "invalid_automation_agent_identity");
  return id;
}

function cleanGeneration(value) {
  const generation = String(value ?? "").trim();
  return /^\d+$/.test(generation) && Number(generation) > 0 ? generation : "";
}

function isLiveSession(session) {
  return ["running", "ready"].includes(String(session.status || "").trim().toLowerCase());
}

function isDeletedLifecycle(value) {
  return ["deleting", "deleted"].includes(String(value || "").trim().toLowerCase());
}

function unauthorized(cause) {
  return httpError(401, "automation_agent_unauthorized", cause);
}

module.exports = {
  CLOCK_SKEW_SECONDS,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  TOKEN_TTL_SECONDS,
  createAutomationAgentAuthService,
  mintToken,
  safeTokenEqual,
  signClaims,
  verifyToken,
};
