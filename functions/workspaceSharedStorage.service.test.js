"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  SHARED_STORAGE_REGION,
  SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS,
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
(async () => {
  const created = createHarness();
  await assert.rejects(
      created.service.prepareWorkspaceSharedStorage(ownerUid, workspaceId),
      /workspace_shared_storage_required/,
  );
  assert.equal(created.getCreateCalls(), 0, "storage validation must never create a bucket");

  const existing = createHarness({metadata: validMetadata(), workspace: {
    sharedStorage: {
      state: "ready",
      bucketName,
      projectId: project.projectId,
      projectNumber: project.projectNumber,
      storageGeneration: "existing-generation",
      treePrefix: "trees/existing-generation",
    },
  }});
  assert.deepEqual(await existing.service.prepareWorkspaceSharedStorage(ownerUid, workspaceId), {
    state: "ready",
    errorCode: null,
  });
  assert.equal(existing.getCreateCalls(), 0, "existing shared storage must be reused");

  const foreign = createHarness({
    metadata: validMetadata({labels: {"mapache-workspace-id": "other", "mapache-owner-uid": "other"}}),
    workspace: {sharedStorage: {bucketName, projectId: project.projectId, projectNumber: project.projectNumber, storageGeneration: "existing-generation"}},
  });
  await assert.rejects(
      foreign.service.prepareWorkspaceSharedStorage(ownerUid, workspaceId),
      /workspace_bucket_ownership_conflict/,
  );
  assert.notEqual(foreign.getWorkspace().sharedStorageState, "error", "validation must not rewrite workspace state");

  const wrongRegion = createHarness({
    metadata: validMetadata({location: "europe-west1"}),
    workspace: {sharedStorage: {bucketName, projectId: project.projectId, projectNumber: project.projectNumber, storageGeneration: "existing-generation"}},
  });
  await assert.rejects(
      wrongRegion.service.prepareWorkspaceSharedStorage(ownerUid, workspaceId),
      /workspace_bucket_region_mismatch/,
  );

  const iamFailure = createHarness({
    metadata: validMetadata(),
    iamError: new Error("permission denied"),
    workspace: {sharedStorage: {bucketName, projectId: project.projectId, projectNumber: project.projectNumber, storageGeneration: "existing-generation"}},
  });
  await assert.rejects(
      iamFailure.service.prepareWorkspaceSharedStorage(ownerUid, workspaceId),
      /workspace_bucket_iam_failed/,
  );
  assert.equal(iamFailure.getWorkspace().sharedStorage.errorCode, undefined, "validation must not rewrite workspace state");

  const active = createHarness({sessions: [{id: "main", status: "running"}]});
  await assert.rejects(
      active.service.prepareWorkspaceSharedStorage(ownerUid, workspaceId),
      /workspace_must_be_paused/,
  );
  assert.equal(active.getCreateCalls(), 0);

  const prepared = createHarness({
    metadata: validMetadata(),
    workspace: {
      sharedStorageState: "legacy",
      sharedStorage: {
        state: "ready",
        bucketName,
        projectId: project.projectId,
        projectNumber: project.projectNumber,
        operationId: "existing-operation",
        storageGeneration: "existing-generation",
        treePrefix: "trees/existing-generation",
      },
    },
  });
  const reused = await prepared.service.validateExistingWorkspaceSharedStorage(ownerUid, workspaceId);
  assert.equal(reused.bucketName, bucketName);
  assert.equal(reused.storageGeneration, "existing-generation");
  assert.equal(reused.treePrefix, "trees/existing-generation");
  assert.equal(prepared.getCreateCalls(), 0, "reusing a prepared workspace must not create another bucket");

  const missingExisting = createHarness({
    workspace: {
      sharedStorage: {
        state: "ready",
        bucketName,
        projectId: project.projectId,
        projectNumber: project.projectNumber,
        storageGeneration: "existing-generation",
        treePrefix: "trees/existing-generation",
      },
    },
  });
  await assert.rejects(
      missingExisting.service.validateExistingWorkspaceSharedStorage(ownerUid, workspaceId),
      /workspace_bucket_not_found/,
  );
  assert.equal(missingExisting.getCreateCalls(), 0, "a missing referenced bucket must fail closed");

  const incompatibleExisting = createHarness({
    metadata: validMetadata({labels: {"mapache-workspace-id": "other", "mapache-owner-uid": "other"}}),
    workspace: {
      sharedStorage: {
        state: "ready",
        bucketName,
        projectId: project.projectId,
        projectNumber: project.projectNumber,
        storageGeneration: "existing-generation",
        treePrefix: "trees/existing-generation",
      },
    },
  });
  await assert.rejects(
      incompatibleExisting.service.validateExistingWorkspaceSharedStorage(ownerUid, workspaceId),
      /workspace_bucket_ownership_conflict/,
  );
  assert.equal(incompatibleExisting.getCreateCalls(), 0, "an incompatible bucket must not be replaced");

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
