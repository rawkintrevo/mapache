"use strict";

const assert = require("assert");
const {
  createGithubConnectionService,
  normalizeGithubConnectionStatus,
  normalizeGithubInstallationIds,
  normalizeGithubInstallationRecord,
  normalizeGithubReturnTo,
} = require("./githubConnection.service");

assert.deepStrictEqual(normalizeGithubInstallationIds(["1", "bad", 2]), ["1", "2"]);
assert.deepStrictEqual(normalizeGithubInstallationRecord("uid-1", "42", {
  ownerUid: "uid-1",
  installationStatus: "active",
  githubAccountLogin: "octo-org",
  repositorySelection: "selected",
}, new Set(["42"])), {
  installationId: "42",
  githubAccountLogin: "octo-org",
  repositorySelection: "selected",
});
assert.strictEqual(normalizeGithubInstallationRecord("uid-1", "42", {ownerUid: "other"}, new Set(["42"])), null);
assert.strictEqual(normalizeGithubInstallationRecord("uid-1", "42", {installationStatus: "suspended"}, new Set(["42"])), null);
assert.strictEqual(normalizeGithubInstallationRecord("uid-1", "42", {}, new Set(["7"])), null);

assert.deepStrictEqual(normalizeGithubConnectionStatus("uid-1", {
  githubUserId: "123",
  githubLogin: "octocat",
  displayName: "Octo Cat",
  avatarUrl: "https://avatars.githubusercontent.com/u/123?v=4",
  connectionStatus: "connected",
  installationIds: ["42", "77"],
}, [
  {
    id: "42",
    data: {
      ownerUid: "uid-1",
      githubAccountLogin: "octo-org",
      githubAccountType: "Organization",
      repositorySelection: "all",
      installationStatus: "active",
    },
  },
  {
    id: "77",
    data: {
      ownerUid: "uid-1",
      githubAccountLogin: "octo-user",
      githubAccountType: "User",
      repositorySelection: "selected",
      installationStatus: "needs_reauth",
    },
  },
]), {
  connected: true,
  connectionStatus: "needs_reauth",
  githubUserId: "123",
  githubLogin: "octocat",
  displayName: "Octo Cat",
  avatarUrl: "https://avatars.githubusercontent.com/u/123?v=4",
  installationCount: 2,
  installationAccounts: [
    {
      installationId: "42",
      accountLogin: "octo-org",
      accountType: "Organization",
      repositorySelection: "all",
      status: "active",
    },
    {
      installationId: "77",
      accountLogin: "octo-user",
      accountType: "User",
      repositorySelection: "selected",
      status: "needs_reauth",
    },
  ],
});
assert.deepStrictEqual(normalizeGithubConnectionStatus("uid-1", {connectionStatus: "disconnected"}, []), {
  connected: false,
  connectionStatus: "not_connected",
  githubUserId: "",
  githubLogin: "",
  displayName: "",
  avatarUrl: "",
  installationCount: 0,
  installationAccounts: [],
});

assert.strictEqual(normalizeGithubReturnTo("https://example.com/app?x=1"), "https://example.com/app?x=1");
assert.strictEqual(normalizeGithubReturnTo("javascript:alert(1)"), "/");
assert.strictEqual(normalizeGithubReturnTo("not a url"), "/");

console.log("github connection service tests passed");

function createFakeGithubDependencies() {
  const values = new Map();
  function ref(path) {
    const id = path.split("/").at(-1);
    return {
      id,
      path,
      collection(name) { return collection(`${path}/${name}`); },
      async get() {
        const value = values.get(path);
        return {id, exists: values.has(path), data: () => value};
      },
      async set(value, options = {}) {
        values.set(path, options.merge ? {...(values.get(path) || {}), ...value} : {...value});
      },
    };
  }
  function collection(path) {
    return {
      doc(id) { return ref(`${path}/${id}`); },
      async get() {
        const prefix = `${path}/`;
        const docs = [...values.entries()]
            .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
            .map(([key, value]) => ({id: key.slice(prefix.length), ref: ref(key), data: () => value}));
        return {docs};
      },
      where(field, operator, value) {
        assert.deepStrictEqual([field, operator], ["ownerUid", "=="]);
        return {async get() {
          const snap = await collection(path).get();
          return {docs: snap.docs.filter((doc) => doc.data()?.ownerUid === value)};
        }};
      },
    };
  }
  return {
    admin: {firestore: {FieldValue: {serverTimestamp: () => "timestamp"}}},
    db: {
      collection: (name) => collection(name),
      runTransaction: async (callback) => callback({
        get: (target) => target.get(),
        set: (target, value, options) => target.set(value, options),
      }),
    },
    values,
  };
}

(async () => {
  const dependencies = createFakeGithubDependencies();
  const service = createGithubConnectionService({...dependencies, githubClient: {}});
  dependencies.values.set("workspaces/workspace-a", {
    ownerUid: "uid-a",
    source: {type: "github", mode: "connected", connection: {installationId: "42"}},
  });
  dependencies.values.set("githubUsers/uid-a", {connectionStatus: "connected", installationIds: ["42"]});
  dependencies.values.set("githubUsers/uid-a/installations/42", {
    ownerUid: "uid-a",
    installationStatus: "active",
  });
  dependencies.values.set("vmMigrationFences_v2/workspace-a", {operationId: "migration-a"});

  await assert.rejects(service.disconnectGithub("uid-a"),
      (error) => error.publicMessage === "workspace_vm_migration_active");
  assert.strictEqual(dependencies.values.get("githubUsers/uid-a").connectionStatus, "connected");
  assert.strictEqual(dependencies.values.get("githubUsers/uid-a/installations/42").installationStatus, "active");

  dependencies.values.delete("vmMigrationFences_v2/workspace-a");
  const disconnected = await service.disconnectGithub("uid-a");
  assert.strictEqual(disconnected.connected, false);
  assert.strictEqual(dependencies.values.get("githubUsers/uid-a").connectionStatus, "disconnected");
  assert.strictEqual(dependencies.values.get("githubUsers/uid-a/installations/42").installationStatus, "removed");
  console.log("github connection migration fence tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
