"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  SHARED_WORKSPACE_STORAGE_MODE,
  assertSharedWorkspaceMount,
} = require("./sharedWorkspace.helpers");

async function createMount(t, generation = "generation-7") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-shared-workspace-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.mkdir(path.join(root, ".mapache-internal"), {recursive: true});
  await fs.writeFile(path.join(root, ".mapache-internal/workspace-ready.json"), JSON.stringify({
    state: "ready",
    storageGeneration: generation,
  }));
  return root;
}

function configFor(workspaceDir, overrides = {}) {
  return {
    workspaceDir,
    workspaceStorageGeneration: "generation-7",
    workspaceStorageMode: SHARED_WORKSPACE_STORAGE_MODE,
    workspaceStorageReadyMarker: ".mapache-internal/workspace-ready.json",
    privateRuntimeRoot: path.join(path.dirname(workspaceDir), "runtime"),
    privateGitDir: path.join(path.dirname(workspaceDir), "git"),
    agentStateRoot: path.join(path.dirname(workspaceDir), "agent-state"),
    piAgentDir: path.join(path.dirname(workspaceDir), "agent-state/pi"),
    piSessionDir: path.join(path.dirname(workspaceDir), "agent-state/sessions"),
    piWebUiDataDir: path.join(path.dirname(workspaceDir), "agent-state/ui"),
    chromeProfileDir: path.join(path.dirname(workspaceDir), "chrome"),
    browserQaDir: path.join(path.dirname(workspaceDir), "qa"),
    piMcpConfigPath: path.join(path.dirname(workspaceDir), "agent-state/pi/mcp.json"),
    ...overrides,
  };
}

test("shared workspace validation accepts the trusted ready generation", async (t) => {
  const workspaceDir = await createMount(t);
  const result = await assertSharedWorkspaceMount(configFor(workspaceDir));
  assert.equal(result.ok, true);
  assert.equal(result.storageGeneration, "generation-7");
  await assert.rejects(fs.stat(path.join(workspaceDir, ".mapache-internal/.write-probe")), {code: "ENOENT"});
});

test("shared workspace validation rejects a missing or mismatched ready marker", async (t) => {
  const workspaceDir = await createMount(t, "generation-8");
  await assert.rejects(
      assertSharedWorkspaceMount(configFor(workspaceDir)),
      (error) => error.code === "shared_workspace_ready_marker_mismatch",
  );
  await fs.rm(path.join(workspaceDir, ".mapache-internal/workspace-ready.json"));
  await assert.rejects(
      assertSharedWorkspaceMount(configFor(workspaceDir)),
      (error) => error.code === "shared_workspace_ready_marker_missing",
  );
});

test("shared workspace validation rejects private paths inside the mount", async (t) => {
  const workspaceDir = await createMount(t);
  await assert.rejects(
      assertSharedWorkspaceMount(configFor(workspaceDir, {piAgentDir: path.join(workspaceDir, ".pi")})),
      (error) => error.code === "shared_workspace_private_path_invalid",
  );
});
