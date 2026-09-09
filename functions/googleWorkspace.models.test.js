"use strict";

const assert = require("assert");
const {
  GOOGLE_SERVICE_KEYS,
  normalizeGoogleConnectionMetadata,
  normalizeGoogleConnectionSummary,
  normalizeGoogleWorkspaceBinding,
} = require("./googleWorkspace.models");

const services = [...GOOGLE_SERVICE_KEYS];
const base = {
  connectionId: "connection-a",
  googleSubject: "subject-a",
  email: "AccountA@example.com",
  displayName: "Account A",
  grantedScopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.readonly"],
  enabledServices: services,
  oauthClientRef: "299764728235-example.apps.googleusercontent.com",
  createdAt: "2026-08-19T00:00:00Z",
  updatedAt: "2026-08-19T01:00:00Z",
};

assert.deepStrictEqual(normalizeGoogleConnectionMetadata(base), {
  ...base,
  email: "accounta@example.com",
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T01:00:00.000Z",
  status: "connected",
  lastRefreshedAt: null,
});
assert.deepStrictEqual(normalizeGoogleWorkspaceBinding({
  connectionId: "connection-a",
  enabledServices: ["gmail", "gmail", "drive"],
}), {connectionId: "connection-a", enabledServices: ["gmail", "drive"]});
assert.deepStrictEqual(normalizeGoogleConnectionSummary(base), {
  connectionId: "connection-a",
  email: "accounta@example.com",
  displayName: "Account A",
  enabledServices: services,
  status: "connected",
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T01:00:00.000Z",
  lastRefreshedAt: null,
});

for (const payload of [
  {...base, accessToken: "fake"},
  {...base, oauth: {clientSecret: "fake"}},
  {...base, authorizationCode: "fake"},
]) {
  assert.throws(() => normalizeGoogleConnectionMetadata(payload), /google_credential_material_not_allowed/);
}
assert.throws(() => normalizeGoogleConnectionMetadata({...base, enabledServices: ["unknown"]}), /invalid_google_service_keys/);
assert.throws(() => normalizeGoogleConnectionMetadata({...base, email: "not-an-email"}), /invalid_google_email/);
assert.throws(() => normalizeGoogleConnectionMetadata({...base, grantedScopes: ["arbitrary"]}), /invalid_google_scopes/);
assert.throws(() => normalizeGoogleConnectionMetadata({...base, oauthClientRef: "https://client.example"}), /invalid_google_oauth_client_ref/);
assert.throws(() => normalizeGoogleWorkspaceBinding({connectionId: "a", enabledServices: []}), /google_services_required/);
assert.throws(() => normalizeGoogleWorkspaceBinding({connectionId: "a", enabledServices: ["gmail"], refreshToken: "x"}), /google_credential_material_not_allowed/);

console.log("google workspace model tests passed");
