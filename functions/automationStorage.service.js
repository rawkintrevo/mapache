"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const {DEFAULT_BUCKET} = require("./backendConfig");

const AUTOMATION_STORAGE_MODE = "automation-readonly-gcs-v1";
const MOUNT_OPTIONS = ["implicit-dirs=true", "metadata-cache-ttl-secs=0", "file-mode=0755", "dir-mode=0755"];

// Called only with the owner-checked workspace record. Persist this selection on
// the session so provisioning retries cannot choose different input or output.
function automationStorageForWorkspace(workspace, outputId = crypto.randomUUID()) {
  if (!/^[a-f0-9-]{36}$/.test(outputId)) throw new Error("invalid_automation_output_id");
  const bucketName = workspace.bucket || DEFAULT_BUCKET;
  const prefix = safePrefix(workspace.storagePrefix);
  const pointer = workspace.agentRuntimeWorkspaceFiles;
  let input = {bucketName, prefix, kind: "legacy"};
  if (workspace.sharedStorage?.state === "ready" && workspace.sharedStorage.bucketName && workspace.sharedStorage.storageGeneration) {
    input = {
      bucketName: workspace.sharedStorage.bucketName,
      prefix: safePrefix(`trees/${workspace.sharedStorage.storageGeneration}`),
      kind: "shared",
    };
  } else if (pointer?.manifest) {
    const manifestPath = safePrefix(pointer.manifest.objectPath);
    const namespace = `${prefix}/.mapache-internal/agent-snapshots/v1/workspace-files/`;
    if (pointer.manifest.bucketName !== bucketName || !manifestPath.startsWith(namespace) || !manifestPath.endsWith("/manifest.json")) {
      throw new Error("automation_workspace_snapshot_invalid");
    }
    input = {bucketName, prefix: `${path.posix.dirname(manifestPath)}/objects`, kind: "snapshot", manifest: pointer.manifest};
  } else if (workspace.agentUiVersion === "pi-web-ui-v1") {
    // An unsaved marked workspace is empty, never a stale legacy archive.
    input = {bucketName, prefix: `${prefix}/.mapache-internal/automation-empty`, kind: "empty"};
  }
  return {
    workspaceId: workspace.id,
    input,
    output: {id: outputId, bucketName, prefix: `${prefix}/.mapache-internal/automation-outputs/${outputId}`, path: `/automation-output/${outputId}`},
  };
}

async function prepareAutomationStorage(descriptor, storage) {
  if (!descriptor?.input || !descriptor?.output) throw new Error("automation_storage_descriptor_missing");
  const {input, output} = descriptor;
  safePrefix(input.prefix);
  safePrefix(output.prefix);
  if (input.kind === "snapshot") {
    const [content] = await storage.bucket(input.bucketName).file(input.manifest.objectPath).download();
    if (content.length !== input.manifest.byteLength || crypto.createHash("sha256").update(content).digest("hex") !== input.manifest.sha256) {
      throw new Error("automation_workspace_snapshot_invalid");
    }
    const manifest = JSON.parse(content.toString("utf8"));
    if (manifest.kind !== "mapache-workspace-file-state" || manifest.workspaceId !== descriptor.workspaceId || !Array.isArray(manifest.files)) {
      throw new Error("automation_workspace_snapshot_invalid");
    }
    // Saved regular files already have the exact mount layout. Older captures
    // keep symlinks in the manifest only; add their FUSE representation without
    // copying files or changing the saved manifest/main workspace pointer.
    for (const entry of manifest.files) {
      const relative = safeRelativePath(entry.path);
      if (entry.kind !== "symlink") continue;
      const target = String(entry.target || "");
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));
      if (!target || path.posix.isAbsolute(target) || resolved === ".." || resolved.startsWith("../")) {
        throw new Error("automation_workspace_symlink_invalid");
      }
      await createObject(storage, input.bucketName, `${input.prefix}/${relative}`, "", {gcsfuse_symlink_target: target});
    }
  }
  // Directory objects also make empty workspaces and fresh output folders
  // mountable. These create-only writes are idempotent; no bucket is provisioned.
  await createObject(storage, input.bucketName, `${input.prefix}/`, "");
  await createObject(storage, output.bucketName, `${output.prefix}/`, "");
  return descriptor;
}

function buildAutomationStorageTemplate({input, output}) {
  return {
    executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2",
    volumes: [
      volume("workspace-input", input, true),
      volume("automation-output", output, false),
    ],
    containers: [{volumeMounts: [
      {name: "workspace-input", mountPath: "/workspace"},
      {name: "automation-output", mountPath: output.path},
    ]}],
  };
}

function volume(name, source, readOnly) {
  // Cloud Run v2 uses gcs, not the v1 csi/volumeAttributes representation.
  return {name, gcs: {bucket: source.bucketName, readOnly, mountOptions: [`only-dir=${safePrefix(source.prefix)}`, ...MOUNT_OPTIONS]}};
}

async function createObject(storage, bucketName, objectPath, content, metadata = {}) {
  try {
    await storage.bucket(bucketName).file(objectPath).save(content, {
      resumable: false, preconditionOpts: {ifGenerationMatch: 0}, metadata: {metadata},
    });
  } catch (error) {
    if (Number(error.code) !== 412) throw error;
  }
}

function safePrefix(value) {
  const result = safeRelativePath(value);
  if (result.includes(",")) throw new Error("automation_storage_path_invalid");
  return result;
}

function safeRelativePath(value) {
  const result = String(value || "");
  if (!result || result.startsWith("/") || /[\r\n\0]/.test(result) || result.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("automation_storage_path_invalid");
  }
  return result;
}

module.exports = {AUTOMATION_STORAGE_MODE, automationStorageForWorkspace, buildAutomationStorageTemplate, prepareAutomationStorage};
