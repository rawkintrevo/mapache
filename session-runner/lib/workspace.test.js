"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {createWorkspaceService} = require("./workspace");

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
