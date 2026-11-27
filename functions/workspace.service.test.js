"use strict";

const assert = require("assert");
const {
  createWorkspaceService,
  normalizeWorkspaceSourcePayload,
  normalizePublicGitHubRepoUrl,
  normalizeWorkspaceHomePolicy,
  normalizeWorkspaceSyncPolicy,
  parsePublicGitHubRepoUrl,
  renameWorkspace,
  ensureCanonicalSession,
} = require("./workspace.service");
const {REMOTE_LIBVIRT_BACKEND} = require("./runtimeProvider.helpers");

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

async function testCreateRemoteWorkspaceValidatesResourcesOnCreateAndEdit() {
  let stored = null;
  const updates = [];
  const workspaceRef = {
    id: "workspace-remote",
    async update(patch) {
      updates.push(patch);
      stored = {...stored, ...patch};
    },
    async get() {
      return {exists: Boolean(stored), id: this.id, data: () => stored};
    },
  };
  const dependencies = {
    admin: {firestore: {FieldValue: {serverTimestamp: () => "server-time"}}},
    db: {
      collection(name) {
        if (name === "remoteHosts") return {doc: () => ({get: async () => ({data: () => ({
          ownerUid: "user-1", ready: true, status: "ready",
          capacity: {cpuCount: 8, memoryBytes: 32 * 1024 ** 3, freeDiskBytes: 128 * 1024 ** 3},
        })})})};
        assert.strictEqual(name, "workspaces");
        return {doc: () => workspaceRef};
      },
      async runTransaction(fn) {
        return fn({get: (ref) => ref.get(), set: (ref, data) => ref.update(data), update: (ref, data) => ref.update(data)});
      },
    },
    remoteHostService: {
      getRemoteHost: async (uid, hostId) => {
        assert.strictEqual(uid, "user-1");
        assert.strictEqual(hostId, "host-1");
        return {hostId, ready: true};
      },
    },
    runtimeProviderEnabled: () => true,
    runtimeGatewayBaseUrl: () => "https://gateway.example",
    env: {REMOTE_VM_ADMISSION_ENABLED: "true"},
  };
  const service = createWorkspaceService(dependencies);
  const created = await service.createWorkspace("user-1", {
    name: "Remote guest",
    source: {type: "remote-vm", hostId: "host-1"},
    resources: {cpu: "1", memory: "2Gi"},
  });

  assert.equal(created.source.type, REMOTE_LIBVIRT_BACKEND);
  assert.equal(created.source.hostId, "host-1");
  assert.deepStrictEqual(created.resources, {cpu: "1", memory: "2Gi"});
  assert.equal(created.runtimeBackend, REMOTE_LIBVIRT_BACKEND);
  assert.equal(created.runtimeProvider.backend, REMOTE_LIBVIRT_BACKEND);
  assert.equal(created.runtimeProvider.hostId, "host-1");
  assert.equal(updates.length, 1);
  const rename = (resources) => service.renameWorkspace("user-1", workspaceRef.id, {name: "Resized", resources});
  await assert.rejects(rename({cpu: "0", memory: "2Gi"}), /invalid_remote_vm_resources/);
  await assert.rejects(rename({cpu: "2", memory: "32Gi"}), /remote_vm_capacity_exhausted/);
  assert.equal(updates.length, 1);
  const edited = await rename({cpu: "3", memory: "4Gi"});
  assert.deepEqual(edited.resources, {cpu: "3", memory: "4Gi"});
  assert.equal(edited.runtimeProvider.guestResources.vcpus, 1);

  await assert.rejects(
      normalizeWorkspaceSourcePayload("user-1", {source: {type: "remote-libvirt", hostId: "host-1"}}, {
        env: {REMOTE_VM_ADMISSION_ENABLED: "true"},
        remoteHostService: {getRemoteHost: async () => ({ready: false, status: "unreachable"})},
      }),
      /remote_host_not_ready/,
  );
}

async function testRemoteWorkspaceAdmissionDisabledBeforeHostLookupOrWrite() {
  let hostLookups = 0;
  let workspaceWrites = 0;
  const dependencies = {
    admin: {firestore: {FieldValue: {serverTimestamp: () => "server-time"}}},
    db: {collection: () => ({add: async () => { workspaceWrites += 1; }})},
    env: {REMOTE_VM_ADMISSION_ENABLED: "false"},
    remoteHostService: {
      getRemoteHost: async () => {
        hostLookups += 1;
        return {ready: true};
      },
    },
  };
  const service = createWorkspaceService(dependencies);
  for (const type of ["remote-vm", "remote-libvirt"]) {
    await assert.rejects(
        service.createWorkspace("user-1", {name: "Remote guest", source: {type, hostId: "host-1"}}),
        /remote_vm_admission_disabled/,
    );
  }
  assert.equal(hostLookups, 0);
  assert.equal(workspaceWrites, 0);
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
    {id: "auto-run-a", runtimeKind: "automation", status: "running", updatedAt: "2026-09-14T12:00:00Z"},
    {id: "auto-run-b", runtimeKind: "automation", status: "running", updatedAt: "2026-09-15T12:00:00Z"},
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
  testRemoteWorkspaceAdmissionDisabledBeforeHostLookupOrWrite(),
  testCreateRemoteWorkspaceValidatesResourcesOnCreateAndEdit(),
  testCanonicalSessionAdoptionPrefersActiveRuntime(),
]).then(() => {
  console.log("workspace service tests passed");
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
