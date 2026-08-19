"use strict";

const assert = require("assert");
const {
  consumeGoogleOAuthState,
  createGoogleOAuthStateService,
  issueGoogleOAuthState,
} = require("./googleWorkspaceOAuthState.service");

function publicMessage(error) {
  return error && error.publicMessage;
}

let now = Date.parse("2026-08-19T00:00:00Z");
const service = createGoogleOAuthStateService({
  secret: "test-secret",
  now: () => now,
  ttlMs: 1000,
});
const token = service.issue({
  uid: "user-a",
  workspaceId: "workspace-a",
  attemptId: "attempt-a",
  serviceKeys: ["gmail", "drive", "gmail"],
});
assert.deepStrictEqual(service.consume(token, {uid: "user-a", workspaceId: "workspace-a"}), {
  uid: "user-a",
  workspaceId: "workspace-a",
  attemptId: "attempt-a",
  serviceKeys: ["gmail", "drive"],
  issuedAt: now,
  expiresAt: now + 1000,
});
assert.throws(() => service.consume(token), (error) => publicMessage(error) === "replayed_google_oauth_state");

const mismatch = service.issue({uid: "user-a", workspaceId: "workspace-a", serviceKeys: []});
assert.throws(() => service.consume(mismatch, {uid: "user-b"}), (error) => publicMessage(error) === "google_oauth_state_mismatch");

now += 1001;
const expired = service.issue({uid: "user-a", workspaceId: "workspace-a", serviceKeys: []});
now += 1001;
assert.throws(() => service.consume(expired), (error) => publicMessage(error) === "expired_google_oauth_state");

const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
assert.throws(() => consumeGoogleOAuthState(tampered, {}, {secret: "test-secret", now: () => now, consumed: new Set()}),
    (error) => publicMessage(error) === "invalid_google_oauth_state");
assert.throws(() => issueGoogleOAuthState({uid: "user-a", workspaceId: "workspace-a", serviceKeys: ["Gmail"]}, {
  secret: "test-secret", now: () => now, ttlMs: 1000,
}), (error) => publicMessage(error) === "invalid_google_oauth_services");

console.log("google workspace OAuth state tests passed");
