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
  assert.deepStrictEqual(normalizeSelection({serviceKeys: ["gmail"], accessLevel: "write"}), {
    serviceKeys: ["gmail"],
    accessLevel: "write",
    scopes: [
      "openid",
      "email",
      "profile",
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
  const state = createGoogleOAuthStateService({secret: "state-secret", now: () => 1000, ttlMs: 100000, db: createFakeDb()});
  const calls = [];
  let includeRefreshToken = true;
  const oauth = createGoogleWorkspaceOAuthService({
    clientId: "299764728235-example.apps.googleusercontent.com",
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
        ...(includeRefreshToken ? {refresh_token: "refresh-fake"} : {}),
        scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly",
      });
      return response(200, {sub: "subject-a", email: "a@example.com", name: "Account A"});
    },
  });
  const start = await oauth.startGoogleConnection("user-a", "workspace-a", {serviceKeys: ["gmail"]});
  const params = new URL(start.authorizationUrl).searchParams;
  assert.strictEqual(params.get("prompt"), "consent select_account");
  assert.strictEqual(params.get("redirect_uri"), "https://mapache.test/api/google/callback");
  assert.deepStrictEqual(params.get("scope").split(" ").slice(0, 3), ["openid", "email", "profile"]);
  assert.strictEqual(params.get("scope").includes("https://www.googleapis.com/auth/gmail.readonly"), true);
  assert.strictEqual(params.get("client_id"), "299764728235-example.apps.googleusercontent.com");
  assert.strictEqual(start.authorizationUrl.includes("client-secret"), false);
  const completed = await oauth.completeGoogleConnection({state: params.get("state"), code: "code-fake"});
  assert.strictEqual(completed.status, 200);
  assert.strictEqual(completed.html.includes("refresh-fake"), false);
  assert.strictEqual(bindings.get("user-a:workspace-a").enabledServices[0], "gmail");
  assert.strictEqual(calls[0].options.body.toString().includes("code-fake"), true);
  const stored = [...connections.values()][0];
  assert.deepStrictEqual(stored.metadata.grantedScopes.slice(0, 3), ["openid", "email", "profile"]);
  assert.strictEqual(decryptSecret(stored.encryptedCredentials, "encryption-secret"), "refresh-fake");
  assert.strictEqual(JSON.stringify(stored.summary).includes("refresh-fake"), false);

  calls.length = 0;
  const refreshed = await oauth.refreshGoogleConnection("user-a", stored.metadata.connectionId);
  assert.strictEqual(refreshed.accessToken, "access-fake");
  assert.strictEqual(calls.length, 1);
  const encrypted = encryptSecret("another-secret", "encryption-secret");
  assert.strictEqual(decryptSecret(encrypted, "encryption-secret"), "another-secret");
  await assert.rejects(oauth.completeGoogleConnection({state: params.get("state"), code: "code-fake"}), /replayed_google_oauth_state/);

  const reconnect = await oauth.startGoogleConnection("user-a", "workspace-a", {serviceKeys: ["gmail"], reconnect: true});
  const reconnectParams = new URL(reconnect.authorizationUrl).searchParams;
  assert.strictEqual(reconnectParams.get("prompt"), "consent select_account");
  includeRefreshToken = false;
  await assert.rejects(
      oauth.completeGoogleConnection({state: reconnectParams.get("state"), code: "reconnect-code"}),
      /google_refresh_token_missing/,
  );
  console.log("google workspace OAuth service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
