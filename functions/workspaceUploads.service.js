"use strict";

const {DEFAULT_BUCKET} = require("./backendConfig");
const {httpError} = require("./backendUtils.helpers");
const MAX_UPLOAD_BYTES = 1024 ** 3;

function uploadsForWorkspace(workspace) {
  const prefix = workspace.storagePrefix || workspace.workspaceStoragePrefix;
  if (typeof prefix !== "string" || !prefix || /[\0\r\n,]/.test(prefix) ||
      prefix.split("/").some((part) => !part || part === "." || part === "..")) {
    throw httpError(409, "workspace_upload_storage_unavailable");
  }
  return {
    bucketName: workspace.bucket || workspace.workspaceStorageBucket || DEFAULT_BUCKET,
    prefix: `${prefix}/.mapache-internal/uploads`,
  };
}

function validateUpload(body = {}) {
  const {name, size} = body;
  if (typeof name !== "string" || !name.trim() || name === "." || name === ".." ||
      /[/\\\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name, "utf8") > 240) {
    throw httpError(400, "invalid_upload_filename");
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
    throw httpError(400, "upload_size_must_be_between_1_byte_and_1_gib");
  }
  return {name, size};
}

function createWorkspaceUploadsService({requireWorkspace, storage}) {
  return {
    async createUpload(uid, workspaceId, body, origin) {
      const workspace = await requireWorkspace(uid, workspaceId);
      if (workspace.source?.type === "ssh") throw httpError(409, "uploads_require_cloud_workspace");
      const {name, size} = validateUpload(body);
      const descriptor = uploadsForWorkspace(workspace);
      const file = storage.bucket(descriptor.bucketName).file(`${descriptor.prefix}/${name}`);
      const [exists] = await file.exists();
      if (exists) throw httpError(409, "upload_filename_already_exists_rename_file");
      // GCS enforces the declared content length. A generation precondition also
      // prevents a concurrent upload from replacing a completed file.
      const [uploadUrl] = await file.createResumableUpload({
        origin: origin || undefined,
        metadata: {contentType: "application/octet-stream", contentLength: size},
        preconditionOpts: {ifGenerationMatch: 0},
      });
      return {uploadUrl, path: `/uploads/${name}`, size};
    },
  };
}

async function buildUploadsStorageTemplate(workspace, storage) {
  const descriptor = uploadsForWorkspace(workspace);
  try {
    await storage.bucket(descriptor.bucketName).file(`${descriptor.prefix}/`).save("", {
      resumable: false, preconditionOpts: {ifGenerationMatch: 0},
    });
  } catch (error) {
    if (Number(error.code) !== 412) throw error;
  }
  return {
    executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2",
    volumes: [{name: "workspace-uploads", gcs: {
      bucket: descriptor.bucketName, readOnly: true,
      mountOptions: [`only-dir=${descriptor.prefix}`, "implicit-dirs=true", "metadata-cache-ttl-secs=0",
        "file-mode=0444", "dir-mode=0555"],
    }}],
    containers: [{volumeMounts: [{name: "workspace-uploads", mountPath: "/uploads"}]}],
  };
}

module.exports = {MAX_UPLOAD_BYTES, validateUpload, uploadsForWorkspace, createWorkspaceUploadsService, buildUploadsStorageTemplate};
