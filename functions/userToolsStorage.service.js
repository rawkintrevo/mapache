"use strict";

const crypto = require("node:crypto");
const {DEFAULT_BUCKET} = require("./backendConfig");

const USER_TOOLS_VOLUME_NAME = "user-tools";
const USER_TOOLS_MOUNT_PATH = "/root/.local";
const USER_TOOLS_BIN_PATH = `${USER_TOOLS_MOUNT_PATH}/bin`;
const USER_TOOLS_STORAGE_MODE = "owner-gcsfuse-v1";
const USER_TOOLS_PREFIX_ROOT = "mapache-user-tools";
const USER_TOOLS_MOUNT_OPTIONS = [
  "implicit-dirs=true",
  "metadata-cache-ttl-secs=0",
  "stat-cache-max-size-mb=0",
  "type-cache-max-size-mb=0",
  "file-mode=0755",
  "dir-mode=0755",
  "log-severity=warning",
];

function userToolsStorageForOwner(ownerUid, options = {}) {
  const normalizedOwnerUid = String(ownerUid || "").trim();
  if (!normalizedOwnerUid) throw new Error("user_tools_owner_required");
  const bucketName = String(
      options.bucketName || process.env.USER_TOOLS_STORAGE_BUCKET || DEFAULT_BUCKET || "",
  ).trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucketName)) {
    throw new Error("invalid_user_tools_bucket");
  }
  const ownerHash = crypto.createHash("sha256").update(normalizedOwnerUid).digest("hex");
  return {
    bucketName,
    ownerHash,
    prefix: `${USER_TOOLS_PREFIX_ROOT}/${ownerHash}/.mapache-internal/tools`,
    binPath: USER_TOOLS_BIN_PATH,
    mountPath: USER_TOOLS_MOUNT_PATH,
    mode: USER_TOOLS_STORAGE_MODE,
  };
}

async function prepareUserToolsStorage(descriptor, storage) {
  if (!descriptor || !descriptor.bucketName || !descriptor.prefix) {
    throw new Error("user_tools_storage_descriptor_required");
  }
  const bucket = storage.bucket(descriptor.bucketName);
  await createDirectoryMarker(bucket.file(`${descriptor.prefix}/`));
  await createDirectoryMarker(bucket.file(`${descriptor.prefix}/bin/`));
  return descriptor;
}

function buildUserToolsStorageTemplate(descriptor) {
  if (!descriptor || !descriptor.bucketName || !descriptor.prefix) {
    throw new Error("user_tools_storage_descriptor_required");
  }
  return {
    executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2",
    volumes: [{
      name: USER_TOOLS_VOLUME_NAME,
      gcs: {
        bucket: descriptor.bucketName,
        readOnly: false,
        mountOptions: [`only-dir=${descriptor.prefix}`, ...USER_TOOLS_MOUNT_OPTIONS],
      },
    }],
    containers: [{
      volumeMounts: [{
        name: USER_TOOLS_VOLUME_NAME,
        mountPath: USER_TOOLS_MOUNT_PATH,
      }],
    }],
  };
}

async function createDirectoryMarker(file) {
  try {
    await file.save("", {
      resumable: false,
      preconditionOpts: {ifGenerationMatch: 0},
    });
  } catch (error) {
    if (Number(error.code) !== 412) throw error;
  }
}

module.exports = {
  USER_TOOLS_BIN_PATH,
  USER_TOOLS_MOUNT_PATH,
  USER_TOOLS_MOUNT_OPTIONS,
  USER_TOOLS_PREFIX_ROOT,
  USER_TOOLS_STORAGE_MODE,
  USER_TOOLS_VOLUME_NAME,
  buildUserToolsStorageTemplate,
  prepareUserToolsStorage,
  userToolsStorageForOwner,
};
