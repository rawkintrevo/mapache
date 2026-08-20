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

function createFakeDb() {
  const records = new Map();
  function reference(parts) {
    return {
      path: parts.join("/"),
      collection: (name) => reference([...parts, name]),
      doc: (name) => reference([...parts, name]),
    };
  }
  return {
    records,
    collection: (name) => reference([name]),
    async runTransaction(callback) {
      return callback({
        get: async (ref) => ({exists: records.has(ref.path)}),
        create: (ref, value) => records.set(ref.path, value),
      });
    },
  };
}

(async () => {
  let now = Date.parse("2026-08-19T00:00:00Z");
  const db = createFakeDb();
  const service = createGoogleOAuthStateService({
    secret: "test-secret",
    now: () => now,
    ttlMs: 1000,
    db,
  });
  const token = service.issue({
    uid: "user-a",
    workspaceId: "workspace-a",
    attemptId: "attempt-a",
    serviceKeys: ["gmail", "drive", "gmail"],
  });
  assert.deepStrictEqual(await service.consume(token, {uid: "user-a", workspaceId: "workspace-a"}), {
    uid: "user-a",
    workspaceId: "workspace-a",
    attemptId: "attempt-a",
    reconnect: false,
    serviceKeys: ["gmail", "drive"],
    issuedAt: now,
    expiresAt: now + 1000,
  });
  await assert.rejects(service.consume(token), (error) => publicMessage(error) === "replayed_google_oauth_state");

  const mismatch = service.issue({uid: "user-a", workspaceId: "workspace-a", serviceKeys: []});
  await assert.rejects(service.consume(mismatch, {uid: "user-b"}), (error) => publicMessage(error) === "google_oauth_state_mismatch");

  now += 1001;
  const expired = service.issue({uid: "user-a", workspaceId: "workspace-a", serviceKeys: []});
  now += 1001;
  await assert.rejects(service.consume(expired), (error) => publicMessage(error) === "expired_google_oauth_state");

  const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
  await assert.rejects(consumeGoogleOAuthState(tampered, {}, {secret: "test-secret", now: () => now, db}),
      (error) => publicMessage(error) === "invalid_google_oauth_state");
  assert.throws(() => issueGoogleOAuthState({uid: "user-a", workspaceId: "workspace-a", serviceKeys: ["Gmail"]}, {
    secret: "test-secret", now: () => now, ttlMs: 1000,
  }), (error) => publicMessage(error) === "invalid_google_oauth_services");

  const durableDb = createFakeDb();
  const durableA = createGoogleOAuthStateService({secret: "test-secret", now: () => now, db: durableDb});
  const durableB = createGoogleOAuthStateService({secret: "test-secret", now: () => now, db: durableDb});
  const durableToken = durableA.issue({uid: "user-a", workspaceId: "workspace-a", serviceKeys: ["gmail"]});
  await durableA.consume(durableToken);
  await assert.rejects(durableB.consume(durableToken), (error) => publicMessage(error) === "replayed_google_oauth_state");
  assert.strictEqual(durableDb.records.size, 1);

  console.log("google workspace OAuth state tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
