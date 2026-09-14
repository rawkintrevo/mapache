"use strict";

const assert = require("assert");
const {
  createWorkspaceService,
  normalizePublicGitHubRepoUrl,
  normalizeWorkspaceHomePolicy,
  normalizeWorkspaceSyncPolicy,
  parsePublicGitHubRepoUrl,
  renameWorkspace,
  ensureCanonicalSession,
} = require("./workspace.service");

assert.strictEqual(normalizePublicGitHubRepoUrl(123), "123");
assert.throws(() => normalizePublicGitHubRepoUrl({}), /missing_github_repo_url/);

assert.deepStrictEqual(parsePublicGitHubRepoUrl("https://github.com/rawkintrevo/mapache"), {
  owner: "rawkintrevo",
  repo: "mapache",
  cloneUrl: "https://github.com/rawkintrevo/mapache.git",
});
assert.deepStrictEqual(parsePublicGitHubRepoUrl("https://www.github.com/rawkintrevo/mapache.git"), {
  owner: "rawkintrevo",
  repo: "mapache",
  cloneUrl: "https://github.com/rawkintrevo/mapache.git",
});
assert.throws(() => parsePublicGitHubRepoUrl("http://github.com/rawkintrevo/mapache"), /github_repo_url_must_use_https/);
assert.throws(() => parsePublicGitHubRepoUrl("https://github.com/rawkintrevo/mapache?tab=readme"), /invalid_github_repo_url/);
assert.throws(() => parsePublicGitHubRepoUrl("https://example.com/rawkintrevo/mapache"), /unsupported_github_repo_host/);

assert.deepStrictEqual(normalizeWorkspaceSyncPolicy({type: "blank"}), {
  mode: "blank",
  exclude: [],
});
assert.deepStrictEqual(normalizeWorkspaceSyncPolicy({type: "github"}), {
  mode: "github-cache",
  exclude: [
    ".git/",
    "node_modules/",
    "dist/",
    "build/",
    ".next/",
    ".mapache-internal/",
  ],
});

assert.deepStrictEqual(normalizeWorkspaceHomePolicy({
  bucket: "bucket-1",
  storagePrefix: "workspaces/u/demo",
}), {
  mode: "persistent",
  path: "/root",
  bucket: "bucket-1",
  storagePrefix: "workspaces/u/demo/.mapache-internal/home",
  archiveName: "home.tar.gz",
});
assert.deepStrictEqual(normalizeWorkspaceHomePolicy({
  bucket: "bucket-1",
  storagePrefix: "workspaces/u/demo",
}, {mode: "ephemeral"}), {
  mode: "ephemeral",
  path: "/root",
  bucket: "bucket-1",
  storagePrefix: "",
  archiveName: "home.tar.gz",
});
assert.throws(() => normalizeWorkspaceHomePolicy({
  bucket: "bucket-1",
  storagePrefix: "workspaces/u/demo",
}, {path: "../root"}), /invalid_workspace_home_path/);

async function testRenameWorkspace() {
  let workspace = {ownerUid: "user-1", name: "Old name"};
  const workspaceRef = {
    async get() {
      return {exists: true, id: "workspace-1", data: () => workspace};
    },
    async update(update) {
      workspace = {...workspace, ...update};
    },
  };
  const dependencies = {
    admin: {firestore: {FieldValue: {serverTimestamp: () => "server-time"}}},
    db: {collection: () => ({doc: () => workspaceRef})},
  };

  const renamed = await renameWorkspace("user-1", "workspace-1", {name: "  New name  "}, dependencies);
  assert.deepStrictEqual(renamed, {
    id: "workspace-1",
    ownerUid: "user-1",
    name: "New name",
    updatedAt: "server-time",
  });
  await assert.rejects(
      renameWorkspace("user-1", "workspace-1", {name: "   "}, dependencies),
      /invalid_workspace_name/,
  );
  await assert.rejects(
      renameWorkspace("user-2", "workspace-1", {name: "Nope"}, dependencies),
      /workspace_forbidden/,
  );
}

async function testCreateWorkspaceUsesManagedDefaults() {
  let stored = null;
  const workspaceRef = {
    id: "workspace-1",
    async get() {
      return {exists: Boolean(stored), id: this.id, data: () => stored};
    },
  };
  const dependencies = {
    admin: {firestore: {FieldValue: {serverTimestamp: () => "server-time"}}},
    db: {
      collection(name) {
        assert.strictEqual(name, "workspaces");
        return {
          add: async (doc) => {
            stored = doc;
            return workspaceRef;
          },
        };
      },
    },
  };
  const service = createWorkspaceService(dependencies);
  const created = await service.createWorkspace("user-1", {name: "Managed blank", source: {type: "blank"}});
  assert.strictEqual(created.agentUiVersion, "pi-web-ui-v1");
  assert.strictEqual(created.source.type, "blank");
  await assert.rejects(
      service.createWorkspace("user-1", {name: "Dev machine", source: {type: "ssh"}}),
      /unsupported_workspace_source_type/,
  );
}

async function testCanonicalSessionAdoptionPrefersActiveRuntime() {
  let workspace = {ownerUid: "user-1", canonicalSessionId: null};
  const workspaceRef = {
    async update(update) {
      workspace = {...workspace, ...update};
    },
  };
  const sessions = [
    {id: "stopped", status: "stopped", updatedAt: "2026-09-13T12:00:00Z"},
    {id: "running", status: "running", updatedAt: "2026-09-13T11:00:00Z"},
  ];
  const dependencies = {
    admin: {firestore: {FieldValue: {serverTimestamp: () => "server-time"}}},
    db: {
      collection: () => ({
        doc: () => ({
          collection: () => ({
            get: async () => ({docs: sessions.map((session) => ({id: session.id, data: () => session, ref: {}}))}),
          }),
        }),
      }),
    },
  };
  const adopted = await ensureCanonicalSession("user-1", {
    id: "workspace-1",
    data: () => workspace,
    ref: workspaceRef,
  }, dependencies);
  assert.strictEqual(adopted.canonicalSessionId, "running");
  assert.strictEqual(workspace.canonicalSessionId, "running");
}

Promise.all([
  testRenameWorkspace(),
  testCreateWorkspaceUsesManagedDefaults(),
  testCanonicalSessionAdoptionPrefersActiveRuntime(),
]).then(() => {
  console.log("workspace service tests passed");
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
