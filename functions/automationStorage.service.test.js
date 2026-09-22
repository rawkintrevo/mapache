"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {test} = require("node:test");
const {automationStorageForWorkspace, prepareAutomationStorage, buildAutomationStorageTemplate} = require("./automationStorage.service");

const workspace = {id: "w", bucket: "existing-bucket", storagePrefix: "workspaces/u/w", agentUiVersion: "pi-web-ui-v1"};
function fixture() {
  const objects = new Map();
  const writes = [];
  const storage = {bucket: (bucket) => ({file: (name) => ({
    download: async () => [objects.get(`${bucket}/${name}`).content],
    save: async (content, options) => {
      const key = `${bucket}/${name}`;
      if (objects.has(key) && options.preconditionOpts.ifGenerationMatch === 0) throw Object.assign(new Error("exists"), {code: 412});
      objects.set(key, {content: Buffer.from(content), options});
      writes.push(key);
    },
  })})};
  return {objects, writes, storage};
}

test("concurrent runs reuse the existing bucket with disjoint outputs and a read-only source", async () => {
  const a = automationStorageForWorkspace(workspace);
  const b = automationStorageForWorkspace(workspace);
  assert.notEqual(a.output.id, b.output.id);
  assert.equal(a.input.kind, "empty");
  assert.equal(a.output.bucketName, workspace.bucket);
  assert.match(a.output.prefix, /\.mapache-internal\/automation-outputs\/[a-f0-9-]{36}$/);
  const {storage, writes} = fixture();
  await prepareAutomationStorage(a, storage);
  await prepareAutomationStorage(a, storage);
  await prepareAutomationStorage(b, storage);
  assert.equal(writes.length, 3);
  const template = buildAutomationStorageTemplate(a);
  assert.equal(template.volumes[0].gcs.readOnly, true);
  assert.equal(template.volumes[1].gcs.readOnly, false);
  assert.equal(template.containers[0].volumeMounts[0].mountPath, "/workspace");
  assert.equal(template.containers[0].volumeMounts[1].mountPath, a.output.path);
  assert.equal(template.volumes.some((v) => v.nfs || v.csi), false);
});

test("pins the saved snapshot, preserves symlinks and never copies or overwrites input files", async () => {
  const f = fixture();
  const base = `${workspace.storagePrefix}/.mapache-internal/agent-snapshots/v1/workspace-files/1/boot/capture`;
  const content = Buffer.from(JSON.stringify({kind: "mapache-workspace-file-state", workspaceId: "w", files: [
    {path: "hello, world.txt", kind: "workspace-file", objectPath: `${base}/objects/hello.txt`},
    {path: "hello-link", kind: "symlink", target: "hello.txt"},
  ]}));
  const pointer = {manifest: {bucketName: workspace.bucket, objectPath: `${base}/manifest.json`, byteLength: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex")}};
  f.objects.set(`${workspace.bucket}/${base}/manifest.json`, {content});
  f.objects.set(`${workspace.bucket}/${base}/objects/hello.txt`, {content: Buffer.from("original")});
  const source = {...workspace, agentRuntimeWorkspaceFiles: pointer};
  const a = automationStorageForWorkspace(source);
  source.agentRuntimeWorkspaceFiles = null;
  await prepareAutomationStorage(a, f.storage);
  assert.equal(a.input.prefix, `${base}/objects`);
  assert.equal(f.objects.get(`${workspace.bucket}/${base}/objects/hello.txt`).content.toString(), "original");
  assert.equal(f.objects.get(`${workspace.bucket}/${base}/objects/hello-link`).options.metadata.metadata.gcsfuse_symlink_target, "hello.txt");
  assert.equal(f.writes.some((key) => key.endsWith("hello.txt")), false);
  a.input.manifest.sha256 = "wrong";
  await assert.rejects(prepareAutomationStorage(a, f.storage), /automation_workspace_snapshot_invalid/);
});

test("supports legacy and existing shared trees without a provisioning requirement", () => {
  assert.equal(automationStorageForWorkspace({...workspace, agentUiVersion: null}).input.prefix, workspace.storagePrefix);
  const descriptor = automationStorageForWorkspace({...workspace, sharedStorage: {state: "ready", bucketName: "existing-shared", storageGeneration: "7"}});
  assert.equal(descriptor.input.prefix, "trees/7");
  assert.equal(descriptor.input.bucketName, "existing-shared");
  assert.equal(descriptor.output.bucketName, workspace.bucket);
  assert.throws(() => automationStorageForWorkspace({...workspace, storagePrefix: "x/../y"}), /automation_storage_path_invalid/);
  assert.throws(() => automationStorageForWorkspace({...workspace, agentRuntimeWorkspaceFiles: {manifest: {bucketName: "foreign", objectPath: "manifest.json"}}}), /automation_workspace_snapshot_invalid/);
});
