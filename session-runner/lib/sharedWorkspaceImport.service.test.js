"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {execFileSync} = require("node:child_process");
const test = require("node:test");
const {createSharedWorkspaceImportService} = require("./sharedWorkspaceImport.service");

function runGit(cwd, ...args) {
  return execFileSync("git", args, {cwd, encoding: "utf8"}).trim();
}

function createStorage({failOncePath = ""} = {}) {
  const objects = new Map();
  let generation = 0;
  let failed = false;
  function file(objectPath) {
    return {
      async delete() { objects.delete(objectPath); },
      async download() {
        const object = objects.get(objectPath);
        if (!object) throw Object.assign(new Error("not found"), {code: 404});
        return [object.content];
      },
      async getMetadata() {
        const object = objects.get(objectPath);
        if (!object) throw Object.assign(new Error("not found"), {code: 404});
        return [{generation: object.generation, metadata: object.metadata}];
      },
      async save(content, options = {}) {
        if (failOncePath === objectPath && !failed) {
          failed = true;
          throw Object.assign(new Error("injected upload failure"), {code: "storage_failed"});
        }
        if (options.ifGenerationMatch === 0 && objects.has(objectPath)) {
          throw Object.assign(new Error("precondition failed"), {code: 412});
        }
        generation += 1;
        objects.set(objectPath, {
          content: Buffer.from(content),
          generation: String(generation),
          metadata: options.metadata?.metadata || {},
        });
      },
    };
  }
  return {
    bucket() { return {file}; },
    objects,
  };
}

async function createSource(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-shared-import-source-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  runGit(root, "init", "-b", "main");
  runGit(root, "config", "user.name", "Test User");
  runGit(root, "config", "user.email", "test@example.com");
  await fs.writeFile(path.join(root, "tracked.txt"), "tracked\n", {mode: 0o640});
  await fs.mkdir(path.join(root, "empty"));
  await fs.symlink("tracked.txt", path.join(root, "tracked-link"));
  await fs.mkdir(path.join(root, ".mapache-internal"));
  await fs.writeFile(path.join(root, ".mapache-internal", "secret.txt"), "private\n");
  runGit(root, "add", "tracked.txt");
  runGit(root, "commit", "-m", "seed");
  await fs.writeFile(path.join(root, "untracked.txt"), "untracked\n");
  return root;
}

function config(storage) {
  return {
    bucketName: "workspace-bucket",
    internalStorageDir: ".mapache-internal",
    prefix: "workspaces/user/workspace-1",
    workspaceId: "workspace-1",
    storage,
  };
}

test("shared workspace import preserves dirty files, links, modes, empty dirs, and private Git seed", async (t) => {
  const sourceRoot = await createSource(t);
  const storage = createStorage();
  const service = createSharedWorkspaceImportService({config: config(storage), storage});
  const result = await service.importWorktree({operationId: "operation-1", sourceRoot});

  assert.equal(result.state, "ready");
  assert.equal(result.treePrefix, "trees/operation-1");
  assert.equal(result.readyMarker, ".mapache-internal/workspace-ready.json");
  assert.equal(storage.objects.has("trees/operation-1/tracked.txt"), true);
  assert.equal(storage.objects.has("trees/operation-1/untracked.txt"), true);
  assert.equal(storage.objects.has("trees/operation-1/tracked-link"), true);
  assert.equal(storage.objects.has("trees/operation-1/empty/.mapache-directory"), true);
  assert.equal(storage.objects.has("trees/operation-1/.git"), false);
  assert.equal(storage.objects.has("trees/operation-1/.mapache-internal/workspace-ready.json"), true);
  assert.equal(storage.objects.has("workspaces/user/workspace-1/.mapache-internal/shared-workspace/git/seed.tar.gz"), true);
  assert.equal(storage.objects.has(".mapache-internal/shared-workspace-imports/operation-1/control.json"), true);
  assert.equal(result.objectCount >= 4, true);
});

test("shared workspace import resumes an interrupted operation and refuses altered destination objects", async (t) => {
  const sourceRoot = await createSource(t);
  const storage = createStorage({failOncePath: "trees/operation-2/untracked.txt"});
  const service = createSharedWorkspaceImportService({config: config(storage), storage});
  await assert.rejects(
      service.importWorktree({operationId: "operation-2", sourceRoot}),
      (error) => error.code === "shared_workspace_import_failed" && error.cause?.code === "storage_failed",
  );
  const resumed = await service.importWorktree({operationId: "operation-2", sourceRoot});
  assert.equal(resumed.state, "ready");

  const tracked = storage.objects.get("trees/operation-2/tracked.txt");
  tracked.content = Buffer.from("foreign\n");
  await assert.rejects(
      service.importWorktree({operationId: "operation-2", sourceRoot}),
      (error) => error.code === "shared_workspace_import_destination_conflict",
  );
});

test("shared workspace import rejects unsafe links and unsupported filesystem entries before cutover", async (t) => {
  const sourceRoot = await createSource(t);
  await fs.symlink("../../outside", path.join(sourceRoot, "unsafe"));
  const storage = createStorage();
  const service = createSharedWorkspaceImportService({config: config(storage), storage});
  await assert.rejects(
      service.importWorktree({operationId: crypto.randomUUID(), sourceRoot}),
      (error) => error.code === "shared_workspace_import_unsafe_symlink",
  );
  assert.equal(storage.objects.size, 0);
});
