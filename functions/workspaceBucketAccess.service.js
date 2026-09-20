"use strict";

const {httpError} = require("./backendUtils.helpers");

const RUNNER_OBJECT_ROLE = "roles/storage.objectUser";
const RUNNER_SERVICE_ACCOUNT = "mapache-runner@pi-agents-cloud.iam.gserviceaccount.com";
const PUBLIC_MEMBERS = new Set(["allUsers", "allAuthenticatedUsers"]);
const MAX_IAM_RETRIES = 3;

function accessError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.publicMessage = code;
  Object.assign(error, details);
  return error;
}

function normalizeWorkspaceBucketBinding(binding = {}, options = {}) {
  const projectId = String(binding.projectId || options.projectId || "").trim();
  const bucketName = String(binding.bucketName || "").trim();
  const workspaceId = String(binding.workspaceId || "").trim();
  const ownerUid = String(binding.ownerUid || "").trim();
  if (!projectId || projectId !== String(options.expectedProjectId || projectId).trim()) {
    throw accessError("workspace_bucket_project_mismatch");
  }
  if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucketName)) {
    throw accessError("invalid_workspace_bucket_name");
  }
  if (!workspaceId || !ownerUid) throw accessError("invalid_workspace_bucket_binding");
  return {projectId, bucketName, workspaceId, ownerUid};
}

function expectedBucketLabels(binding) {
  return {
    "mapache-workspace-id": binding.workspaceId,
    "mapache-owner-uid": binding.ownerUid,
  };
}

function assertBucketMetadata(metadata = {}, binding, options = {}) {
  if (metadata.name && metadata.name !== binding.bucketName) {
    throw accessError("workspace_bucket_binding_mismatch");
  }
  const project = String(metadata.project || metadata.projectId || options.projectId || "").trim();
  if (project && project !== binding.projectId) throw accessError("workspace_bucket_project_mismatch");
  const labels = metadata.labels || {};
  const expectedLabels = expectedBucketLabels(binding);
  for (const [key, value] of Object.entries(expectedLabels)) {
    if (String(labels[key] || "") !== value) throw accessError("workspace_bucket_binding_mismatch", {label: key});
  }
  const uniformAccess = metadata.iamConfiguration?.uniformBucketLevelAccess;
  if (uniformAccess && uniformAccess.enabled !== true) throw accessError("workspace_bucket_uniform_access_required");
  const publicAccessPrevention = metadata.iamConfiguration?.publicAccessPrevention;
  if (publicAccessPrevention && publicAccessPrevention !== "enforced") {
    throw accessError("workspace_bucket_public_access_prevention_required");
  }
  return true;
}

function assertWorkspaceOwner(workspace, binding) {
  if (!workspace || workspace.ownerUid !== binding.ownerUid) {
    throw accessError("workspace_bucket_owner_mismatch");
  }
  return true;
}

function isPublicMember(member) {
  return PUBLIC_MEMBERS.has(String(member || "").trim());
}

function assertNoPublicBindings(policy = {}) {
  for (const binding of policy.bindings || []) {
    if ((binding.members || []).some(isPublicMember)) throw accessError("workspace_bucket_public_grant");
  }
  return true;
}

function clonePolicy(policy = {}) {
  return {
    ...policy,
    bindings: (policy.bindings || []).map((binding) => ({
      ...binding,
      members: [...(binding.members || [])],
    })),
  };
}

function addRunnerObjectBinding(policy = {}, member = `serviceAccount:${RUNNER_SERVICE_ACCOUNT}`) {
  const next = clonePolicy(policy);
  assertNoPublicBindings(next);
  let binding = next.bindings.find((candidate) => candidate.role === RUNNER_OBJECT_ROLE);
  if (!binding) {
    binding = {role: RUNNER_OBJECT_ROLE, members: []};
    next.bindings.push(binding);
  }
  if (!binding.members.includes(member)) binding.members.push(member);
  return next;
}

function removeRunnerObjectBinding(policy = {}, member = `serviceAccount:${RUNNER_SERVICE_ACCOUNT}`) {
  const next = clonePolicy(policy);
  assertNoPublicBindings(next);
  next.bindings = next.bindings
      .map((binding) => binding.role === RUNNER_OBJECT_ROLE ? {
        ...binding,
        members: binding.members.filter((candidate) => candidate !== member),
      } : binding)
      .filter((binding) => binding.members.length > 0);
  return next;
}

function isEtagConflict(error) {
  return Boolean(error && ([409, 412].includes(Number(error.code)) ||
    /etag|condition|precondition|conflict/i.test(String(error.message || ""))));
}

function createWorkspaceBucketAccessService(dependencies = {}) {
  const storage = dependencies.storage;
  const db = dependencies.db;
  const projectId = String(dependencies.projectId || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "").trim();
  const getBucket = (bucketName) => storage.bucket(bucketName);

  async function loadAndValidate(binding) {
    const normalized = normalizeWorkspaceBucketBinding(binding, {expectedProjectId: projectId});
    if (!db) throw accessError("workspace_bucket_database_required");
    const workspaceSnap = await db.collection("workspaces").doc(normalized.workspaceId).get();
    if (!workspaceSnap.exists) throw httpError(404, "workspace_not_found");
    assertWorkspaceOwner(workspaceSnap.data(), normalized);
    const bucket = getBucket(normalized.bucketName);
    const [metadata] = await bucket.getMetadata();
    assertBucketMetadata(metadata, normalized, {projectId});
    return {binding: normalized, bucket};
  }

  async function updateBinding(binding, operation) {
    const {bucket, binding: normalized} = await loadAndValidate(binding);
    for (let attempt = 0; attempt < MAX_IAM_RETRIES; attempt++) {
      const [policy] = await bucket.iam.getPolicy({requestedPolicyVersion: 3});
      const nextPolicy = operation(policy);
      nextPolicy.version = Math.max(Number(policy.version || 1), 3);
      try {
        await bucket.iam.setPolicy(nextPolicy);
        return {binding: normalized, policy: nextPolicy};
      } catch (error) {
        if (!isEtagConflict(error) || attempt === MAX_IAM_RETRIES - 1) throw error;
      }
    }
    throw accessError("workspace_bucket_iam_update_failed");
  }

  return {
    ensureRunnerObjectAccess: (binding) => updateBinding(binding, (policy) => addRunnerObjectBinding(policy)),
    removeRunnerObjectAccess: (binding) => updateBinding(binding, (policy) => removeRunnerObjectBinding(policy)),
  };
}

module.exports = {
  MAX_IAM_RETRIES,
  PUBLIC_MEMBERS,
  RUNNER_OBJECT_ROLE,
  RUNNER_SERVICE_ACCOUNT,
  addRunnerObjectBinding,
  assertBucketMetadata,
  assertNoPublicBindings,
  assertWorkspaceOwner,
  createWorkspaceBucketAccessService,
  expectedBucketLabels,
  isEtagConflict,
  normalizeWorkspaceBucketBinding,
  removeRunnerObjectBinding,
};
