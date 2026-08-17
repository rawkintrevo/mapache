"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {createBrowserAccessVerifier} = require("./browserAccess");

function signedToken(secret, sessionId, exp) {
  const payload = Buffer.from(JSON.stringify({sid: sessionId, exp})).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

test("accepts a signed current-session token from query or cookie", () => {
  const now = 1_700_000_000_000;
  const verifier = createBrowserAccessVerifier({
    secret: "browser-secret",
    sessionId: "session-1",
    now: () => now,
  });
  const token = signedToken("browser-secret", "session-1", now / 1000 + 60);

  assert.equal(verifier.verify(token), true);
  assert.equal(verifier.extractToken({url: `/browser/?mapache_access=${token}`, headers: {}}), token);
  assert.equal(verifier.extractToken({url: "/browser/", headers: {cookie: `mapache_access=${encodeURIComponent(token)}`}}), token);
  assert.equal(verifier.maxAgeMs(token), 60_000);
});

test("rejects tampered, expired, and cross-session browser tokens", () => {
  const now = 1_700_000_000_000;
  const verifier = createBrowserAccessVerifier({secret: "browser-secret", sessionId: "session-1", now: () => now});
  assert.equal(verifier.verify(signedToken("browser-secret", "session-1", now / 1000 - 1)), false);
  assert.equal(verifier.verify(signedToken("browser-secret", "session-2", now / 1000 + 60)), false);
  assert.equal(verifier.verify(`${signedToken("browser-secret", "session-1", now / 1000 + 60)}x`), false);
  assert.equal(verifier.verify("not-a-token"), false);
});

test("does not decode malformed cookie values or expose secrets through max age", () => {
  const verifier = createBrowserAccessVerifier({secret: "browser-secret", sessionId: "session-1", now: () => 1_700_000_000_000});
  assert.equal(verifier.extractToken({url: "/", headers: {cookie: "mapache_access=%ZZ"}}), "");
  assert.equal(verifier.maxAgeMs("not-a-token"), 0);
});
