"use strict";

const crypto = require("node:crypto");
const logger = require("firebase-functions/logger");
const {admin: defaultAdmin, auth: defaultAuth, db: defaultDb, storage: defaultStorage} = require("./backendContext");
const {httpError, isGoogleAlreadyExists, isGoogleNotFound} = require("./backendUtils.helpers");
const {
  assertBucketMetadata,
  createWorkspaceBucketAccessService,
  expectedBucketLabels,
} = require("./workspaceBucketAccess.service");

const SHARED_STORAGE_REGION = "us-central1";
const SHARED_STORAGE_CLASS = "STANDARD";
const SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS = 604800;
const SHARED_STORAGE_STATES = new Set(["legacy", "preparing", "migrating", "ready", "error"]);
const ACTIVE_RUNNER_STATUSES = new Set([
  "queued",
  "provisioning",
  "running",
  "ready",
  "restarting",
  "resizing",
  "needs_service",
  "stopping",
  "cleanup_pending",
  "deleting",
]);

function storageError(code, status = 502, details = {}) {
  const error = httpError(status, code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function normalizeProjectNumber(value) {
  const projectNumber = String(value || "").trim();
  if (!/^\d+$/.test(projectNumber)) return "";
  return projectNumber;
}

function deriveWorkspaceBucketName(projectNumber, workspaceId) {
  const normalizedProjectNumber = normalizeProjectNumber(projectNumber);
  const normalizedWorkspaceId = String(workspaceId || "").trim();
  if (!normalizedProjectNumber || !normalizedWorkspaceId) {
    throw storageError("workspace_bucket_identity_unavailable", 500);
  }
  return `mpw-${normalizedProjectNumber}-${sha256(normalizedWorkspaceId).slice(0, 24)}`;
}

function operationIdForWorkspace(workspaceId) {
  return `shared-storage-${sha256(workspaceId).slice(0, 32)}`;
}

function storageState(workspace = {}) {
  return String(workspace.sharedStorageState || workspace.sharedStorage?.state || "legacy")
      .trim().toLowerCase() || "legacy";
}

function isActiveRunner(session = {}) {
  return ACTIVE_RUNNER_STATUSES.has(String(session.status || "").trim().toLowerCase());
}

function isNotFound(error) {
  return isGoogleNotFound(error) || Number(error?.code) === 404 || Number(error?.status) === 404;
}

function isAlreadyExists(error) {
  return isGoogleAlreadyExists(error) || Number(error?.code) === 409 || Number(error?.status) === 409;
}

function bucketCreationMetadata(binding) {
  return {
    location: SHARED_STORAGE_REGION,
    storageClass: SHARED_STORAGE_CLASS,
    hierarchicalNamespace: {enabled: true},
    iamConfiguration: {
      uniformBucketLevelAccess: {enabled: true},
      publicAccessPrevention: "enforced",
    },
    softDeletePolicy: {
      retentionDurationSeconds: String(SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS),
    },
    versioning: {enabled: false},
    labels: expectedBucketLabels(binding),
  };
}

function assertSharedBucketContract(metadata = {}, binding) {
  assertBucketMetadata(metadata, binding, {
    projectId: binding.projectId,
  });

  if (String(metadata.location || "").toLowerCase() !== SHARED_STORAGE_REGION) {
    throw storageError("workspace_bucket_region_mismatch", 409);
  }
  if (String(metadata.storageClass || "").toUpperCase() !== SHARED_STORAGE_CLASS) {
    throw storageError("workspace_bucket_storage_class_mismatch", 409);
  }
  if (metadata.hierarchicalNamespace?.enabled !== true) {
    throw storageError("workspace_bucket_hns_required", 409);
  }
  if (metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true) {
    throw storageError("workspace_bucket_uniform_access_required", 409);
  }
  if (metadata.iamConfiguration?.publicAccessPrevention !== "enforced") {
    throw storageError("workspace_bucket_public_access_prevention_required", 409);
  }
  const softDeleteSeconds = Number(metadata.softDeletePolicy?.retentionDurationSeconds);
  if (softDeleteSeconds !== SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS) {
    throw storageError("workspace_bucket_soft_delete_retention_mismatch", 409);
  }
  if (metadata.versioning?.enabled === true) {
    throw storageError("workspace_bucket_versioning_enabled", 409);
  }
  return true;
}

function normalizeStorageFailure(error) {
  if ([
    "workspace_bucket_binding_mismatch",
    "workspace_bucket_owner_mismatch",
    "workspace_bucket_project_mismatch",
  ].includes(error?.publicMessage)) {
    return storageError("workspace_bucket_ownership_conflict", 409);
  }
  if (error?.publicMessage && /^workspace_/.test(error.publicMessage)) return error;
  if (Number(error?.code) === 403 || Number(error?.status) === 403) {
    return storageError("workspace_bucket_access_denied", 502);
  }
  if (isAlreadyExists(error)) return storageError("workspace_bucket_ownership_conflict", 409);
  if (isNotFound(error)) return storageError("workspace_bucket_not_found", 404);
  return storageError("workspace_shared_storage_operation_failed", 502);
}

function publicStorageState(workspace = {}) {
  const state = storageState(workspace);
  return {
    state: SHARED_STORAGE_STATES.has(state) ? state : "error",
    errorCode: workspace.sharedStorage?.errorCode || workspace.sharedStorageErrorCode || null,
  };
}

function createWorkspaceSharedStorageService(dependencies = {}) {
  const admin = dependencies.admin || defaultAdmin;
  const db = dependencies.db || defaultDb;
  const auth = dependencies.auth || defaultAuth;
  const storage = dependencies.storage || defaultStorage;
  const now = dependencies.now || (() => new Date());
  const bucketAccess = dependencies.bucketAccessService || createWorkspaceBucketAccessService({
    db,
    projectId: dependencies.projectId || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "",
    storage,
  });

  async function loadWorkspace(uid, workspaceId, options = {}) {
    if (typeof dependencies.requireWorkspace === "function" && options.allowDeleting !== true) {
      return dependencies.requireWorkspace(uid, workspaceId);
    }
    const workspaceRef = db.collection("workspaces").doc(workspaceId);
    const workspaceSnap = await workspaceRef.get();
    if (!workspaceSnap.exists) throw httpError(404, "workspace_not_found");
    const workspace = {id: workspaceSnap.id, ...workspaceSnap.data()};
    if (workspace.ownerUid !== uid) throw httpError(403, "workspace_forbidden");
    if (options.allowDeleting !== true && isWorkspaceDeleted(workspace)) throw httpError(409, "workspace_deleted");
    return workspace;
  }

  function workspaceRef(workspaceId) {
    return db.collection("workspaces").doc(workspaceId);
  }

  async function resolveProjectIdentity() {
    if (typeof dependencies.getProjectIdentity === "function") {
      const identity = await dependencies.getProjectIdentity();
      const projectId = String(identity?.projectId || "").trim();
      const projectNumber = normalizeProjectNumber(identity?.projectNumber);
      if (!projectId || !projectNumber) throw storageError("workspace_bucket_project_identity_unavailable", 502);
      return {projectId, projectNumber};
    }

    const projectId = String(
        dependencies.projectId || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || await auth.getProjectId(),
    ).trim();
    if (!projectId) throw storageError("workspace_bucket_project_identity_unavailable", 502);
    if (normalizeProjectNumber(dependencies.projectNumber)) {
      return {projectId, projectNumber: normalizeProjectNumber(dependencies.projectNumber)};
    }
    const client = await auth.getClient();
    const response = await client.request({
      url: `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`,
      method: "GET",
    });
    const projectNumber = normalizeProjectNumber(response?.data?.projectNumber);
    if (!projectNumber) throw storageError("workspace_bucket_project_identity_unavailable", 502);
    return {projectId, projectNumber};
  }

  async function listSessions(workspaceId) {
    const snap = await workspaceRef(workspaceId).collection("sessions").get();
    return snap.docs.map((doc) => ({id: doc.id, ...doc.data()}));
  }

  function assertWorkspacePaused(sessions) {
    const active = sessions.find(isActiveRunner);
    if (active) throw storageError("workspace_must_be_paused", 409, {sessionId: active.id});
  }

  async function readBucket(bucket) {
    try {
      const [metadata] = await bucket.getMetadata();
      return metadata || {};
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async function createBucket(bucketName, metadata) {
    if (typeof storage.createBucket === "function") {
      await storage.createBucket(bucketName, metadata);
      return;
    }
    const bucket = storage.bucket(bucketName);
    if (typeof bucket.create !== "function") throw storageError("workspace_bucket_client_unavailable", 500);
    await bucket.create(metadata);
  }

  async function ensureBucket(binding) {
    const bucket = storage.bucket(binding.bucketName);
    let metadata = await readBucket(bucket);
    if (!metadata) {
      try {
        await createBucket(binding.bucketName, bucketCreationMetadata(binding));
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      metadata = await readBucket(bucket);
      if (!metadata) throw storageError("workspace_bucket_create_unconfirmed", 502);
    }
    assertSharedBucketContract(metadata, binding);
    return {bucket, metadata};
  }

  function identityFor(workspace, workspaceId, project) {
    const existing = workspace.sharedStorage || {};
    const bucketName = deriveWorkspaceBucketName(project.projectNumber, workspaceId);
    if (existing.bucketName && existing.bucketName !== bucketName) {
      throw storageError("workspace_bucket_identity_mismatch", 409);
    }
    if (existing.projectNumber && normalizeProjectNumber(existing.projectNumber) !== project.projectNumber) {
      throw storageError("workspace_bucket_identity_mismatch", 409);
    }
    const operationId = String(existing.operationId || workspace.sharedStorageOperationId || operationIdForWorkspace(workspaceId)).trim();
    return {
      bucketName,
      projectId: project.projectId,
      projectNumber: project.projectNumber,
      location: SHARED_STORAGE_REGION,
      storageClass: SHARED_STORAGE_CLASS,
      hierarchicalNamespace: true,
      softDeleteRetentionSeconds: SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS,
      versioning: false,
      operationId,
    };
  }

  async function updateStorageState(workspaceId, identity, state, errorCode = null) {
    const update = {
      sharedStorageState: state,
      sharedStorageErrorCode: errorCode,
      sharedStorage: {
        ...identity,
        state,
        errorCode,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await workspaceRef(workspaceId).update(update);
  }

  async function prepareWorkspaceSharedStorage(uid, workspaceId) {
    const workspace = await loadWorkspace(uid, workspaceId);
    const sessions = await listSessions(workspaceId);
    assertWorkspacePaused(sessions);

    let identity;
    try {
      const project = workspace.sharedStorage?.projectId && normalizeProjectNumber(workspace.sharedStorage?.projectNumber) ? {
        projectId: workspace.sharedStorage.projectId,
        projectNumber: normalizeProjectNumber(workspace.sharedStorage.projectNumber),
      } : await resolveProjectIdentity();
      identity = identityFor(workspace, workspaceId, project);
      await updateStorageState(workspaceId, identity, "preparing");
      const binding = {
        projectId: identity.projectId,
        projectNumber: identity.projectNumber,
        bucketName: identity.bucketName,
        workspaceId,
        ownerUid: uid,
      };
      await ensureBucket(binding);
      try {
        await bucketAccess.ensureRunnerObjectAccess(binding);
      } catch (error) {
        throw storageError("workspace_bucket_iam_failed", 502, {cause: error});
      }
      await updateStorageState(workspaceId, identity, "ready");
      return {state: "ready", errorCode: null};
    } catch (error) {
      const normalized = normalizeStorageFailure(error);
      if (identity) {
        try {
          await updateStorageState(workspaceId, identity, "error", normalized.publicMessage);
        } catch (stateError) {
          logger.error("failed to persist shared storage error state", {
            workspaceId,
            error: stateError.message || String(stateError),
          });
        }
      }
      throw normalized;
    }
  }

  // Migration owns the Firestore cutover. This helper only creates/verifies
  // the destination bucket and grants the runner principal access, leaving the
  // legacy workspace pointer authoritative until the importer verifies it.
  async function ensureWorkspaceSharedStorage(uid, workspaceId) {
    const workspace = await loadWorkspace(uid, workspaceId);
    const sessions = await listSessions(workspaceId);
    assertWorkspacePaused(sessions);
    const project = workspace.sharedStorage?.projectId && normalizeProjectNumber(workspace.sharedStorage?.projectNumber) ? {
      projectId: workspace.sharedStorage.projectId,
      projectNumber: normalizeProjectNumber(workspace.sharedStorage.projectNumber),
    } : await resolveProjectIdentity();
    const identity = identityFor(workspace, workspaceId, project);
    const binding = {
      projectId: identity.projectId,
      projectNumber: identity.projectNumber,
      bucketName: identity.bucketName,
      workspaceId,
      ownerUid: uid,
    };
    await ensureBucket(binding);
    try {
      await bucketAccess.ensureRunnerObjectAccess(binding);
    } catch (error) {
      throw storageError("workspace_bucket_iam_failed", 502, {cause: error});
    }
    return identity;
  }

  async function deleteWorkspaceSharedStorage(uid, workspaceId, options = {}) {
    if (options.reason !== "workspace_deleted") {
      throw storageError("workspace_bucket_delete_requires_workspace_deletion", 400);
    }
    const workspace = await loadWorkspace(uid, workspaceId, {allowDeleting: options.allowDeleting === true});
    const sessions = await listSessions(workspaceId);
    assertWorkspacePaused(sessions);
    const identity = workspace.sharedStorage || {};
    if (!identity.bucketName) return {deleted: false, state: publicStorageState(workspace).state};

    const project = identity.projectId && normalizeProjectNumber(identity.projectNumber) ? {
      projectId: identity.projectId,
      projectNumber: normalizeProjectNumber(identity.projectNumber),
    } : await resolveProjectIdentity();
    const binding = {
      projectId: identity.projectId || project.projectId,
      projectNumber: identity.projectNumber || project.projectNumber,
      bucketName: identity.bucketName,
      workspaceId,
      ownerUid: uid,
    };
    const bucket = storage.bucket(binding.bucketName);
    const metadata = await readBucket(bucket);
    if (!metadata) return {deleted: false, bucketDeleted: true, bucketName: binding.bucketName, retainedRecovery: null};
    assertSharedBucketContract(metadata, binding);

    try {
      try {
        if (typeof bucketAccess.removeRunnerObjectAccess === "function") {
          await bucketAccess.removeRunnerObjectAccess(binding);
        }
      } catch (error) {
        throw storageError("workspace_bucket_iam_failed", 502, {cause: error});
      }
      const retainedBytes = await bucketLiveBytes(bucket);
      if (typeof bucket.deleteFiles === "function") {
        await bucket.deleteFiles({force: true});
      } else if (typeof bucket.getFiles === "function") {
        const [files] = await bucket.getFiles();
        await Promise.all(files.map((file) => file.delete()));
      }
      await bucket.delete();
      const recoverableUntil = new Date(new Date(now()).getTime() + SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS * 1000).toISOString();
      return {
        deleted: true,
        bucketName: binding.bucketName,
        retainedRecovery: {
          softDeleteRetentionSeconds: SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS,
          recoverableUntil,
          retainedBytes,
          retainedBytesKnown: retainedBytes !== null,
          note: "Deleted live objects remain recoverable under Cloud Storage soft delete and continue to incur storage charges until retention expires.",
        },
      };
    } catch (error) {
      if (isNotFound(error)) return {deleted: false, bucketDeleted: true, bucketName: binding.bucketName, retainedRecovery: null};
      throw normalizeStorageFailure(error);
    }
  }

  return {
    deleteWorkspaceSharedStorage,
    ensureWorkspaceSharedStorage,
    prepareWorkspaceSharedStorage,
    publicStorageState,
  };
}

function isWorkspaceDeleted(workspace = {}) {
  return workspace.deleted === true || ["deleting", "deleted"].includes(
      String(workspace.lifecycle || workspace.status || "").trim().toLowerCase(),
  );
}

async function bucketLiveBytes(bucket) {
  if (!bucket || typeof bucket.getFiles !== "function") return null;
  try {
    const [files] = await bucket.getFiles();
    let total = 0;
    for (const file of files || []) {
      const size = Number(file?.metadata?.size ?? file?.size);
      if (!Number.isFinite(size) || size < 0) return null;
      total += size;
    }
    return total;
  } catch (_error) {
    // A size read is advisory. Deletion can still safely resume, but callers
    // must not present an unknown byte count as zero retained cost.
    return null;
  }
}

module.exports = {
  ACTIVE_RUNNER_STATUSES,
  SHARED_STORAGE_CLASS,
  SHARED_STORAGE_REGION,
  SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS,
  SHARED_STORAGE_STATES,
  assertSharedBucketContract,
  bucketCreationMetadata,
  createWorkspaceSharedStorageService,
  deriveWorkspaceBucketName,
  normalizeStorageFailure,
  operationIdForWorkspace,
  publicStorageState,
};
