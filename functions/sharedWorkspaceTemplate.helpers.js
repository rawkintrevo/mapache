"use strict";

const SHARED_WORKSPACE_VOLUME_NAME = "workspace";
const SHARED_WORKSPACE_MOUNT_PATH = "/workspace";
const SHARED_WORKSPACE_CSI_DRIVER = "gcsfuse.run.googleapis.com";

const FIXED_MOUNT_OPTIONS = [
  "metadata-cache-ttl-secs=0",
  "stat-cache-max-size-mb=0",
  "type-cache-max-size-mb=0",
  "implicit-dirs=true",
  "file-mode=0755",
  "dir-mode=0755",
  "log-severity=warning",
];

function descriptorValue(value) {
  return String(value ?? "").trim();
}

function assertBucketName(bucketName) {
  if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucketName)) {
    throw new Error("invalid_trusted_shared_storage_bucket");
  }
}

function assertStorageGeneration(storageGeneration) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(storageGeneration) || storageGeneration.includes("..")) {
    throw new Error("invalid_trusted_shared_storage_generation");
  }
}

/**
 * Build the Cloud Run v2 template fragment for the backend-owned workspace
 * bucket. This function is pure: callers must pass a descriptor obtained from
 * the trusted workspace record, never from a session/client payload.
 */
function buildSharedWorkspaceTemplate(trustedStorageDescriptor = {}) {
  const bucketName = descriptorValue(trustedStorageDescriptor.bucketName);
  const storageGeneration = descriptorValue(trustedStorageDescriptor.storageGeneration);
  if (!bucketName || !storageGeneration) throw new Error("trusted_shared_storage_descriptor_required");
  assertBucketName(bucketName);
  assertStorageGeneration(storageGeneration);

  return {
    executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2",
    volumes: [{
      name: SHARED_WORKSPACE_VOLUME_NAME,
      csi: {
        driver: SHARED_WORKSPACE_CSI_DRIVER,
        readOnly: false,
        volumeAttributes: {
          bucketName,
          mountOptions: [
            `only-dir=trees/${storageGeneration}`,
            ...FIXED_MOUNT_OPTIONS,
          ].join(","),
        },
      },
    }],
    containers: [{
      volumeMounts: [{
        name: SHARED_WORKSPACE_VOLUME_NAME,
        mountPath: SHARED_WORKSPACE_MOUNT_PATH,
      }],
    }],
  };
}

module.exports = {
  FIXED_MOUNT_OPTIONS,
  SHARED_WORKSPACE_CSI_DRIVER,
  SHARED_WORKSPACE_MOUNT_PATH,
  SHARED_WORKSPACE_VOLUME_NAME,
  buildSharedWorkspaceTemplate,
};
