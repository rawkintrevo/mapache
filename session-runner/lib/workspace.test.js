"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {createWorkspaceService} = require("./workspace");
const {SHARED_WORKSPACE_STORAGE_MODE} = require("./sharedWorkspace.helpers");

test("marked runtimes do not fall back to the legacy flat workspace prefix", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-managed-workspace-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = {
    agentRuntimeEnabled: true,
    agentRuntimeGeneration: 3,
    bucketName: "workspace-bucket",
    directoryMarkerFile: ".mapache-directory",
    homeDir: path.join(root, "home"),
    homeStorageBucketName: "workspace-bucket",
    homeStoragePrefix: "",
    homeSyncMode: "ephemeral",
    internalStorageDir: ".mapache-internal",
    legacyArchiveStorageDirs: [],
    legacyDirectoryMarkerFiles: [],
    legacyInternalStorageDirs: [],
    piAgentDir: path.join(root, "state", "pi"),
    piSessionDir: path.join(root, "state", "sessions"),
    prefix: "users/u/workspaces/w",
    sessionId: "session-1",
    workspaceDir: path.join(root, "workspace"),
    workspaceId: "w",
    workspaceSyncPolicyExclude: [],
  };
  let legacyFlatReads = 0;
  let restores = 0;
  const storage = {
    bucket() {
      return {
        async getFiles() {
          legacyFlatReads++;
          return [[]];
        },
        file() {
          return {
            async exists() {
              return [false];
            },
          };
        },
      };
    },
  };
  const service = createWorkspaceService({
    checkpointRestore: {
      async restoreCheckpoint() {
        restores++;
        return {ok: true, skipped: true, reason: "no_published_checkpoint"};
      },
    },
    config,
    git: {
      isBlankWorkspace: () => true,
      isGithubWorkspace: () => false,
    },
    storage,
  });

  await service.ensureWorkspace();
  await service.prepareWorkspaceSource();
  assert.equal(legacyFlatReads, 0);
  await service.restoreCheckpoint();
  assert.equal(restores, 1);
  assert.deepEqual(await fs.readdir(config.workspaceDir), []);
});

test("shared GCS workspaces are authoritative and skip legacy source synchronization", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-shared-workspace-service-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(path.join(workspaceDir, ".mapache-internal"), {recursive: true});
  await fs.writeFile(path.join(workspaceDir, ".mapache-internal/workspace-ready.json"), JSON.stringify({
    state: "ready",
    storageGeneration: "generation-7",
  }));
  const config = {
    agentRuntimeEnabled: true,
    agentRuntimeGeneration: 3,
    bucketName: "workspace-bucket",
    directoryMarkerFile: ".mapache-directory",
    homeDir: path.join(root, "home"),
    internalStorageDir: ".mapache-internal",
    legacyArchiveStorageDirs: [],
    legacyDirectoryMarkerFiles: [],
    legacyInternalStorageDirs: [],
    piAgentDir: path.join(root, "state", "pi"),
    piSessionDir: path.join(root, "state", "sessions"),
    prefix: "users/u/workspaces/w",
    sessionId: "session-1",
    workspaceDir,
    workspaceId: "w",
    workspaceStorageGeneration: "generation-7",
    workspaceStorageMode: SHARED_WORKSPACE_STORAGE_MODE,
    workspaceStorageReadyMarker: ".mapache-internal/workspace-ready.json",
    workspaceSyncPolicyExclude: [],
  };
  let legacySyncCalled = false;
  const service = createWorkspaceService({
    checkpointRestore: {
      async restoreCheckpoint() {
        assert.fail("shared workspace must not restore workspace checkpoint files");
      },
    },
    config,
    git: {
      cloneGithubWorkspace: async () => assert.fail("shared workspace must not clone"),
      isBlankWorkspace: () => false,
      isGithubWorkspace: () => true,
    },
    storage: {
      bucket() {
        legacySyncCalled = true;
        return {async getFiles() { return [[]]; }};
      },
    },
  });
  await service.ensureWorkspace();
  assert.deepEqual(await service.prepareWorkspaceSource(), {ok: true, skipped: true, reason: "shared_gcsfuse_authoritative"});
  assert.deepEqual(await service.syncDown(), {ok: true, skipped: true, reason: "shared_gcsfuse_authoritative"});
  assert.equal(legacySyncCalled, false);
});
