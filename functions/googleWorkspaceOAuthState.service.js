"use strict";

const crypto = require("crypto");
const {httpError} = require("./backendUtils.helpers");

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function createGoogleOAuthStateService(dependencies = {}) {
  const secret = String(dependencies.secret || process.env.GOOGLE_OAUTH_STATE_SECRET || "");
  const now = dependencies.now || (() => Date.now());
  const ttlMs = Number(dependencies.ttlMs || DEFAULT_TTL_MS);
  const consumed = dependencies.consumed || new Set();
  return {
    issue: (input) => issueGoogleOAuthState(input, {secret, now, ttlMs}),
    consume: (token, expected) => consumeGoogleOAuthState(token, expected, {secret, now, consumed}),
  };
}

function issueGoogleOAuthState(input = {}, dependencies = {}) {
  if (!dependencies.secret) throw httpError(503, "google_oauth_state_unavailable");
  const uid = cleanContext(input.uid, "invalid_google_oauth_state");
  const workspaceId = cleanContext(input.workspaceId, "invalid_google_oauth_state");
  const attemptId = cleanAttemptId(input.attemptId || crypto.randomUUID());
  const serviceKeys = normalizeServiceKeys(input.serviceKeys || []);
  const now = Number(dependencies.now ? dependencies.now() : Date.now());
  const expiresAt = now + Number(dependencies.ttlMs || DEFAULT_TTL_MS);
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || expiresAt <= now) {
    throw httpError(500, "google_oauth_state_unavailable");
  }
  const payload = {
    v: 1,
    uid,
    workspaceId,
    attemptId,
    serviceKeys,
    iat: now,
    exp: expiresAt,
    nonce: crypto.randomBytes(18).toString("base64url"),
  };
  const encodedPayload = encode(payload);
  return `${encodedPayload}.${sign(encodedPayload, dependencies.secret)}`;
}

function consumeGoogleOAuthState(token, expected = {}, dependencies = {}) {
  if (!dependencies.secret) throw httpError(503, "google_oauth_state_unavailable");
  const [encodedPayload, signature, extra] = String(token || "").split(".");
  if (!encodedPayload || !signature || extra || !safeEqual(signature, sign(encodedPayload, dependencies.secret))) {
    throw httpError(400, "invalid_google_oauth_state");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch (error) {
    throw httpError(400, "invalid_google_oauth_state", error);
  }
  const now = Number(dependencies.now ? dependencies.now() : Date.now());
  if (payload.v !== 1 || !payload.uid || !payload.workspaceId || !payload.attemptId ||
      !payload.nonce || !Number.isFinite(payload.exp) || payload.exp <= now) {
    throw httpError(400, "expired_google_oauth_state");
  }
  if (expected.uid && payload.uid !== expected.uid ||
      expected.workspaceId && payload.workspaceId !== expected.workspaceId) {
    throw httpError(403, "google_oauth_state_mismatch");
  }
  if (dependencies.consumed.has(payload.nonce)) throw httpError(400, "replayed_google_oauth_state");
  dependencies.consumed.add(payload.nonce);
  return {
    uid: payload.uid,
    workspaceId: payload.workspaceId,
    attemptId: payload.attemptId,
    serviceKeys: normalizeServiceKeys(payload.serviceKeys || []),
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sign(value, secret) {
  return crypto.createHmac("sha256", String(secret || "")).update(value).digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function cleanContext(value, errorCode) {
  const text = String(value || "").trim();
  if (!text || text.length > 256 || /[\r\n]/.test(text)) throw httpError(400, errorCode);
  return text;
}

function cleanAttemptId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw httpError(400, "invalid_google_oauth_attempt");
  return id;
}

function normalizeServiceKeys(value) {
  if (!Array.isArray(value) || value.some((item) => !/^[a-z][a-z0-9_-]{0,31}$/.test(String(item || "")))) {
    throw httpError(400, "invalid_google_oauth_services");
  }
  return [...new Set(value.map((item) => String(item).toLowerCase()))];
}

module.exports = {
  DEFAULT_TTL_MS,
  consumeGoogleOAuthState,
  createGoogleOAuthStateService,
  issueGoogleOAuthState,
};
