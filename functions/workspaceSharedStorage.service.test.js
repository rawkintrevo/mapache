"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  SHARED_STORAGE_REGION,
  SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS,
  bucketCreationMetadata,
  createWorkspaceSharedStorageService,
  deriveWorkspaceBucketName,
} = require("./workspaceSharedStorage.service");

const workspaceId = "workspace-1";
const ownerUid = "owner-1";
const project = {projectId: "pi-agents-cloud", projectNumber: "1234567890"};
const bucketName = deriveWorkspaceBucketName(project.projectNumber, workspaceId);

function createHarness(options = {}) {
  let workspace = {
    id: workspaceId,
    ownerUid,
    ...(options.workspace || {}),
  };
  const sessions = options.sessions || [];
  let metadata = options.metadata === undefined ? null : options.metadata;
  let createCalls = 0;
  let deleteFilesCalls = 0;
  let deleteBucketCalls = 0;
  const updates = [];
  const bucket = {
    async getMetadata() {
      if (!metadata) throw Object.assign(new Error("not found"), {code: 404});
      return [metadata];
    },
    async deleteFiles() {
      deleteFilesCalls++;
    },
    async delete() {
      deleteBucketCalls++;
      metadata = null;
    },
  };
  const db = {
    collection(name) {
      assert.equal(name, "workspaces");
      return {
        doc(id) {
          assert.equal(id, workspaceId);
          return {
            async get() {
              return {exists: true, id: workspaceId, data: () => workspace};
            },
            async update(update) {
              updates.push(update);
              workspace = {...workspace, ...update};
            },
            collection(collectionName) {
              assert.equal(collectionName, "sessions");
              return {
                async get() {
                  return {docs: sessions.map((session, index) => ({
                    id: session.id || `session-${index}`,
                    data: () => session,
                  }))};
                },
              };
            },
          };
        },
      };
    },
  };
  const storage = {
    bucket(name) {
      assert.equal(name, bucketName);
      return bucket;
    },
    async createBucket(name, createMetadata) {
      assert.equal(name, bucketName);
      createCalls++;
      metadata = {
        name,
        project: project.projectId,
        projectNumber: project.projectNumber,
        ...createMetadata,
      };
      if (options.createError) throw options.createError;
    },
  };
  const service = createWorkspaceSharedStorageService({
    admin: {firestore: {FieldValue: {serverTimestamp: () => "server-time"}}},
    bucketAccessService: {
      ensureRunnerObjectAccess: async (binding) => {
        assert.equal(binding.bucketName, bucketName);
        if (options.iamError) throw options.iamError;
      },
    },
    db,
    getProjectIdentity: async () => project,
    requireWorkspace: async () => workspace,
    storage,
  });
  return {
    service,
    getWorkspace: () => workspace,
    getMetadata: () => metadata,
    getCreateCalls: () => createCalls,
    getDeleteFilesCalls: () => deleteFilesCalls,
    getDeleteBucketCalls: () => deleteBucketCalls,
    getUpdates: () => updates,
  };
}

function validMetadata(overrides = {}) {
  return {
    name: bucketName,
    project: project.projectId,
    projectNumber: project.projectNumber,
    labels: {
      "mapache-workspace-id": workspaceId,
      "mapache-owner-uid": ownerUid,
    },
    location: SHARED_STORAGE_REGION,
    storageClass: "STANDARD",
    hierarchicalNamespace: {enabled: true},
    iamConfiguration: {
      uniformBucketLevelAccess: {enabled: true},
      publicAccessPrevention: "enforced",
    },
    softDeletePolicy: {
      retentionDurationSeconds: SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS,
    },
    versioning: {enabled: false},
    ...overrides,
  };
}

assert.equal(
    deriveWorkspaceBucketName(project.projectNumber, workspaceId),
    `mpw-${project.projectNumber}-${crypto.createHash("sha256").update(workspaceId).digest("hex").slice(0, 24)}`,
);
assert.deepEqual(bucketCreationMetadata({workspaceId, ownerUid}), {
  location: SHARED_STORAGE_REGION,
  storageClass: "STANDARD",
  hierarchicalNamespace: {enabled: true},
  iamConfiguration: {
    uniformBucketLevelAccess: {enabled: true},
    publicAccessPrevention: "enforced",
  },
  softDeletePolicy: {retentionDurationSeconds: String(SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS)},
  versioning: {enabled: false},
  labels: {"mapache-workspace-id": workspaceId, "mapache-owner-uid": ownerUid},
});

(async () => {
  const created = createHarness();
  assert.deepEqual(await created.service.prepareWorkspaceSharedStorage(ownerUid, workspaceId), {
    state: "ready",
    errorCode: null,
  });
  assert.equal(created.getCreateCalls(), 1);
  assert.equal(created.getWorkspace().sharedStorage.bucketName, bucketName);
  assert.equal(created.getWorkspace().sharedStorageState, "ready");

  await created.service.prepareWorkspaceSharedStorage(ownerUid, workspaceId);
  assert.equal(created.getCreateCalls(), 1, "reconciliation must not create a second bucket");

  const partial = createHarness({createError: new Error("response lost after create")});
  await assert.rejects(
      partial.service.prepareWorkspaceSharedStorage(ownerUid, workspaceId),
      /workspace_shared_storage_operation_failed/,
  );
  await partial.service.prepareWorkspaceSharedStorage(ownerUid, workspaceId);
  assert.equal(partial.getCreateCalls(), 1, "a partially created bucket must be resumed");

  const foreign = createHarness({metadata: validMetadata({labels: {"mapache-workspace-id": "other", "mapache-owner-uid": "other"}})});
  await assert.rejects(
      foreign.service.prepareWorkspaceSharedStorage(ownerUid, workspaceId),
      /workspace_bucket_ownership_conflict/,
  );
  assert.equal(foreign.getWorkspace().sharedStorageState, "error");

  const wrongRegion = createHarness({metadata: validMetadata({location: "europe-west1"})});
  await assert.rejects(
      wrongRegion.service.prepareWorkspaceSharedStorage(ownerUid, workspaceId),
      /workspace_bucket_region_mismatch/,
  );

  const iamFailure = createHarness({iamError: new Error("permission denied")});
  await assert.rejects(
      iamFailure.service.prepareWorkspaceSharedStorage(ownerUid, workspaceId),
      /workspace_bucket_iam_failed/,
  );
  assert.equal(iamFailure.getWorkspace().sharedStorage.errorCode, "workspace_bucket_iam_failed");

  const active = createHarness({sessions: [{id: "main", status: "running"}]});
  await assert.rejects(
      active.service.prepareWorkspaceSharedStorage(ownerUid, workspaceId),
      /workspace_must_be_paused/,
  );
  assert.equal(active.getCreateCalls(), 0);

  const deletable = createHarness({
    metadata: validMetadata(),
    workspace: {
      sharedStorageState: "ready",
      sharedStorage: {
        bucketName,
        projectId: project.projectId,
        projectNumber: project.projectNumber,
      },
    },
  });
  await assert.rejects(
      deletable.service.deleteWorkspaceSharedStorage(ownerUid, workspaceId),
      /workspace_bucket_delete_requires_workspace_deletion/,
  );
  const deletion = await deletable.service.deleteWorkspaceSharedStorage(
      ownerUid,
      workspaceId,
      {reason: "workspace_deleted"},
  );
  assert.equal(deletion.deleted, true);
  assert.equal(deletable.getDeleteFilesCalls(), 1);
  assert.equal(deletable.getDeleteBucketCalls(), 1);
  assert.equal(deletion.retainedRecovery.softDeleteRetentionSeconds, SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS);

  const activeDeletion = createHarness({
    metadata: validMetadata(),
    sessions: [{id: "runner", status: "stopping"}],
    workspace: {sharedStorage: {bucketName, projectId: project.projectId, projectNumber: project.projectNumber}},
  });
  await assert.rejects(
      activeDeletion.service.deleteWorkspaceSharedStorage(ownerUid, workspaceId, {reason: "workspace_deleted"}),
      /workspace_must_be_paused/,
  );

  console.log("workspace shared storage service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
