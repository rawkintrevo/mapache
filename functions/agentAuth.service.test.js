"use strict";

const assert = require("assert");
const {
  createAgentAuthService,
  normalizePiAuthApiKey,
  normalizePiAuthEntries,
  normalizePiAuthEntryId,
  normalizePiAuthProviderKey,
  normalizePiAuthProviders,
  normalizePiAuthSelection,
  normalizePiAuthStoredProviderKey,
  normalizePlainObject,
  removePiAuthEntry,
  removePiAuthProvider,
  writePiAuthMaps,
} = require("./agentAuth.service");

function publicMessage(error) {
  return error && error.publicMessage;
}

assert.deepStrictEqual(normalizePlainObject({
  token: "abc",
  nested: {count: 1, skip: undefined},
  list: ["a", {b: true}, undefined],
  fn: () => {},
}), {
  token: "abc",
  nested: {count: 1},
  list: ["a", {b: true}],
});
assert.deepStrictEqual(normalizePiAuthProviders({
  " openai ": {type: "api_key", key: "sk"},
  bad: null,
}), {
  openai: {type: "api_key", key: "sk"},
});
assert.deepStrictEqual(normalizePiAuthEntries({}, {openai: {type: "api_key", key: "sk"}}), {
  "legacy-openai": {
    id: "legacy-openai",
    providerKey: "openai",
    label: "openai",
    credential: {type: "api_key", key: "sk"},
    createdAt: "",
  },
});
assert.deepStrictEqual(normalizePiAuthSelection({
  openai: "entry-1",
  anthropic: "entry-1",
}, {
  "entry-1": {providerKey: "openai"},
}), {openai: "entry-1"});
assert.strictEqual(normalizePiAuthEntryId("entry:1_ok"), "entry:1_ok");
assert.strictEqual(normalizePiAuthEntryId("", {required: false}), "");
assert.throws(() => normalizePiAuthEntryId("bad id"), (error) => publicMessage(error) === "invalid_pi_auth_entry");
assert.strictEqual(normalizePiAuthProviderKey("openai"), "openai");
assert.strictEqual(normalizePiAuthProviderKey("github-cli"), "github-cli");
assert.throws(() => normalizePiAuthProviderKey("unknown-provider"), (error) => publicMessage(error) === "invalid_pi_auth_provider");
assert.strictEqual(normalizePiAuthStoredProviderKey("custom-provider"), "custom-provider");
assert.throws(() => normalizePiAuthApiKey(""), (error) => publicMessage(error) === "invalid_pi_auth_key");
assert.strictEqual(normalizePiAuthApiKey(" key "), "key");

const openAiCredential1 = {type: "oauth", access: "first"};
const openAiCredential2 = {type: "oauth", access: "second"};
assert.deepStrictEqual(removePiAuthEntry({"openai-codex": openAiCredential2}, {
  "entry-1": {providerKey: "openai-codex", credential: openAiCredential1, createdAt: "2026-01-01"},
  "entry-2": {providerKey: "openai-codex", credential: openAiCredential2, createdAt: "2026-01-02"},
}, "entry-2"), {
  providers: {"openai-codex": openAiCredential1},
  entries: {"entry-1": {providerKey: "openai-codex", credential: openAiCredential1, createdAt: "2026-01-01"}},
});
assert.deepStrictEqual(removePiAuthEntry({"openai-codex": openAiCredential1}, {
  "entry-1": {providerKey: "openai-codex", credential: openAiCredential1, createdAt: "2026-01-01"},
}, "entry-1"), {providers: {}, entries: {}});
assert.deepStrictEqual(removePiAuthProvider({anthropic: {type: "api_key", key: "secret"}}, {
  "entry-1": {providerKey: "anthropic", credential: {type: "api_key", key: "secret"}},
}, "anthropic"), {providers: {}, entries: {}});

const transactionCalls = [];
writePiAuthMaps({
  update: (ref, payload) => transactionCalls.push({method: "update", ref, payload}),
  set: (ref, payload) => transactionCalls.push({method: "set", ref, payload}),
}, "pi-auth-ref", {exists: true}, {providers: {}, entries: {}, updatedAt: "now", createdAt: "created"});
assert.deepStrictEqual(transactionCalls, [{
  method: "update",
  ref: "pi-auth-ref",
  payload: {providers: {}, entries: {}, updatedAt: "now"},
}]);

function createFakeDependencies() {
  const documents = new Map();
  const sessions = new Map();
  const refFor = (path) => ({
    path,
    async get() {
      const data = documents.get(path);
      return {exists: Boolean(data), data: () => data};
    },
    async set(data, options = {}) {
      documents.set(path, options.merge ? {...(documents.get(path) || {}), ...data} : {...data});
    },
  });
  const db = {
    collection(name) {
      assert.strictEqual(name, "users");
      return {doc: (uid) => ({
        collection(name) {
          assert.strictEqual(name, "private");
          return {doc: (documentId) => refFor(`${uid}/private/${documentId}`)};
        },
      })};
    },
    async runTransaction(callback) {
      const transaction = {
        get: (ref) => ref.get(),
        set: (ref, data) => documents.set(ref.path, {...data}),
        update: (ref, data) => documents.set(ref.path, {...(documents.get(ref.path) || {}), ...data}),
      };
      return callback(transaction);
    },
  };
  return {
    admin: {firestore: {FieldValue: {serverTimestamp: () => "SERVER_TIMESTAMP"}}},
    db,
    documents,
    sessions,
  };
}

(async () => {
  const fake = createFakeDependencies();
  const calls = [];
  const service = createAgentAuthService({
    ...fake,
    requireWorkspace: async () => ({}),
    requireSession: async (uid, workspaceId, sessionId) => ({sessionSnap: fake.sessions.get(`${uid}/${workspaceId}/${sessionId}`)}),
    requestRunnerJson: async (session, routePath, options) => {
      calls.push({session, routePath, options});
      return {ok: true, appliedToRunner: true};
    },
  });

  const auth = await service.savePiAuthProvider("uid-1", "openai", {label: "OpenAI", key: "secret"});
  assert.strictEqual(auth.providers.openai.key, "secret");
  assert.strictEqual(Object.keys(auth.entries).length, 1);
  const entryId = Object.keys(auth.entries)[0];
  assert.ok(fake.documents.has("uid-1/private/agentAuth"));
  assert.ok(!fake.documents.has("uid-1/private/piAuth"));
  await service.deletePiAuthEntry("uid-1", entryId);
  assert.deepStrictEqual((await service.getPiAuth("uid-1")).providers, {});

  let sessionData = {terminalKind: "codex", serviceUrl: "https://runner", shutdownToken: "token"};
  const sessionSnap = {
    data: () => sessionData,
    ref: {set: async (data, options) => {
      assert.deepStrictEqual(options, {merge: true});
      sessionData = {...sessionData, ...data};
    }},
  };
  fake.sessions.set("uid-1/workspace-1/session-1", sessionSnap);
  const selectionResult = await service.saveSessionPiAuthSelection("uid-1", "workspace-1", "session-1", {
    selection: {openai: entryId},
    environmentEntryIds: ["env-1", "env-1"],
  });
  assert.deepStrictEqual(selectionResult.selection, {harness: "codex", providers: {}});
  assert.deepStrictEqual(sessionData.environmentEntryIds, ["env-1"]);
  assert.ok(!Object.prototype.hasOwnProperty.call(sessionData, "piAuthSelection"));
  assert.strictEqual(calls[0].routePath, "/auth/materialize");
  assert.deepStrictEqual(calls[0].options.body.environmentEntryIds, ["env-1"]);

  sessionData = {terminalKind: "shell", serviceUrl: "", shutdownToken: ""};
  await assert.rejects(
      service.saveSessionPiAuthSelection("uid-1", "workspace-1", "session-1", {selection: {}}),
      (error) => error.status === 400 && publicMessage(error) === "auth_selection_unsupported",
  );
  await service.saveSessionPiAuthSelection("uid-1", "workspace-1", "session-1", {selection: {}, environmentEntryIds: []});
  console.log("agent auth service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
