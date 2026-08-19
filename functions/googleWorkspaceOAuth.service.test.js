"use strict";

const assert = require("assert");
const {createGoogleOAuthStateService} = require("./googleWorkspaceOAuthState.service");
const {
  createGoogleWorkspaceOAuthService,
  decryptSecret,
  encryptSecret,
  normalizeSelection,
} = require("./googleWorkspaceOAuth.service");

function response(status, body) {
  return {ok: status >= 200 && status < 300, status, json: async () => body};
}

(async () => {
  assert.deepStrictEqual(normalizeSelection({serviceKeys: ["gmail"], accessLevel: "write"}), {
    serviceKeys: ["gmail"],
    accessLevel: "write",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ],
  });
  assert.throws(() => normalizeSelection({serviceKeys: ["people"], accessLevel: "write"}), /google_write_access_unsupported/);
  assert.throws(() => normalizeSelection({serviceKeys: []}), /invalid_google_service_selection/);

  const connections = new Map();
  const bindings = new Map();
  const connectionService = {
    async getGoogleConnection(uid, id, options = {}) {
      const record = connections.get(`${uid}:${id}`);
      if (!record) {
        const error = new Error("google_connection_not_found");
        error.publicMessage = "google_connection_not_found";
        throw error;
      }
      return options.includePrivate ? record : record.summary;
    },
    async createGoogleConnection(uid, metadata, encryptedCredentials) {
      const summary = {...metadata, googleSubject: metadata.googleSubject};
      connections.set(`${uid}:${metadata.connectionId}`, {metadata, encryptedCredentials, summary});
      return summary;
    },
    async updateGoogleConnection(uid, id, metadata, encryptedCredentials) {
      const record = connections.get(`${uid}:${id}`);
      record.metadata = {...record.metadata, ...metadata};
      if (encryptedCredentials !== undefined) record.encryptedCredentials = encryptedCredentials;
      record.summary = {...record.summary, ...metadata};
      return record.summary;
    },
    async bindGoogleWorkspaceConnection(uid, workspaceId, binding) {
      bindings.set(`${uid}:${workspaceId}`, binding);
      return binding;
    },
    async listGoogleConnections() { return {connections: []}; },
  };
  const state = createGoogleOAuthStateService({secret: "state-secret", now: () => 1000, ttlMs: 100000});
  const calls = [];
  const oauth = createGoogleWorkspaceOAuthService({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://mapache.test/api/google/callback",
    encryptionKey: "encryption-secret",
    connectionsService: connectionService,
    stateService: state,
    requireWorkspace: async (uid, workspaceId) => assert.deepStrictEqual([uid, workspaceId], ["user-a", "workspace-a"]),
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      if (url === "https://oauth2.googleapis.com/token") return response(200, {
        access_token: "access-fake",
        refresh_token: "refresh-fake",
        scope: "https://www.googleapis.com/auth/gmail.readonly",
      });
      return response(200, {sub: "subject-a", email: "a@example.com", name: "Account A"});
    },
  });
  const start = await oauth.startGoogleConnection("user-a", "workspace-a", {serviceKeys: ["gmail"]});
  const params = new URL(start.authorizationUrl).searchParams;
  assert.strictEqual(params.get("prompt"), "select_account");
  assert.strictEqual(params.get("redirect_uri"), "https://mapache.test/api/google/callback");
  assert.strictEqual(start.authorizationUrl.includes("client-secret"), false);
  const completed = await oauth.completeGoogleConnection({state: params.get("state"), code: "code-fake"});
  assert.strictEqual(completed.status, 200);
  assert.strictEqual(completed.html.includes("refresh-fake"), false);
  assert.strictEqual(bindings.get("user-a:workspace-a").enabledServices[0], "gmail");
  assert.strictEqual(calls[0].options.body.toString().includes("code-fake"), true);
  const stored = [...connections.values()][0];
  assert.strictEqual(decryptSecret(stored.encryptedCredentials, "encryption-secret"), "refresh-fake");
  assert.strictEqual(JSON.stringify(stored.summary).includes("refresh-fake"), false);

  calls.length = 0;
  const refreshed = await oauth.refreshGoogleConnection("user-a", stored.metadata.connectionId);
  assert.strictEqual(refreshed.accessToken, "access-fake");
  assert.strictEqual(calls.length, 1);
  const encrypted = encryptSecret("another-secret", "encryption-secret");
  assert.strictEqual(decryptSecret(encrypted, "encryption-secret"), "another-secret");
  await assert.rejects(oauth.completeGoogleConnection({state: params.get("state"), code: "code-fake"}), /replayed_google_oauth_state/);
  console.log("google workspace OAuth service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
