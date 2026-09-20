"use strict";

const assert = require("node:assert/strict");
const {
  RUNNER_OBJECT_ROLE,
  RUNNER_SERVICE_ACCOUNT,
  addRunnerObjectBinding,
  assertBucketMetadata,
  createWorkspaceBucketAccessService,
  removeRunnerObjectBinding,
} = require("./workspaceBucketAccess.service");

const binding = {
  projectId: "pi-agents-cloud",
  bucketName: "mpw-1234-abcdef1234567890abcdef12",
  workspaceId: "workspace-1",
  ownerUid: "owner-1",
};
const metadata = {
  name: binding.bucketName,
  project: binding.projectId,
  labels: {
    "mapache-workspace-id": binding.workspaceId,
    "mapache-owner-uid": binding.ownerUid,
  },
  iamConfiguration: {
    uniformBucketLevelAccess: {enabled: true},
    publicAccessPrevention: "enforced",
  },
};
const runnerMember = `serviceAccount:${RUNNER_SERVICE_ACCOUNT}`;
const existingMember = "serviceAccount:other@pi-agents-cloud.iam.gserviceaccount.com";

assert.doesNotThrow(() => assertBucketMetadata(metadata, binding, {projectId: binding.projectId}));
assert.throws(() => assertBucketMetadata({...metadata, project: "other-project"}, binding), /workspace_bucket_project_mismatch/);
assert.throws(() => assertBucketMetadata({...metadata, labels: {}}, binding), /workspace_bucket_binding_mismatch/);
assert.throws(() => assertBucketMetadata({...metadata, iamConfiguration: {...metadata.iamConfiguration, publicAccessPrevention: "unspecified"}}, binding), /workspace_bucket_public_access_prevention_required/);

const policy = {
  version: 3,
  etag: "etag-1",
  bindings: [
    {role: "roles/storage.objectViewer", members: [existingMember]},
    {role: RUNNER_OBJECT_ROLE, members: [existingMember]},
  ],
};
const added = addRunnerObjectBinding(policy);
assert.deepEqual(added.bindings.find((item) => item.role === RUNNER_OBJECT_ROLE).members, [existingMember, runnerMember]);
assert.deepEqual(policy.bindings.find((item) => item.role === RUNNER_OBJECT_ROLE).members, [existingMember]);
assert.deepEqual(removeRunnerObjectBinding(added).bindings, policy.bindings);
assert.throws(() => addRunnerObjectBinding({bindings: [{role: "roles/storage.admin", members: ["allUsers"]}]}), /workspace_bucket_public_grant/);

(async () => {
  let policyState = policy;
  let setCalls = 0;
  let getCalls = 0;
  const service = createWorkspaceBucketAccessService({
    projectId: binding.projectId,
    db: {collection: () => ({doc: () => ({get: async () => ({exists: true, data: () => ({ownerUid: binding.ownerUid})})})})},
    storage: {
      bucket: () => ({
        getMetadata: async () => [metadata],
        iam: {
          getPolicy: async () => { getCalls++; return [policyState]; },
          setPolicy: async (next) => {
            setCalls++;
            if (setCalls === 1) throw Object.assign(new Error("etag conflict"), {code: 412});
            policyState = next;
          },
        },
      }),
    },
  });
  const result = await service.ensureRunnerObjectAccess(binding);
  assert.equal(getCalls, 2);
  assert.equal(setCalls, 2);
  assert(result.policy.bindings.find((item) => item.role === RUNNER_OBJECT_ROLE).members.includes(runnerMember));
  await service.removeRunnerObjectAccess(binding);
  assert(!policyState.bindings.some((item) => item.role === RUNNER_OBJECT_ROLE && item.members.includes(runnerMember)));
  console.log("workspace bucket access service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
