"use strict";

const assert = require("node:assert/strict");
const {
  buildSharedWorkspaceTemplate,
  FIXED_MOUNT_OPTIONS,
} = require("./sharedWorkspaceTemplate.helpers");

const template = buildSharedWorkspaceTemplate({
  bucketName: "mpw-1234567890-workspace1",
  storageGeneration: "42",
});

assert.equal(template.executionEnvironment, "EXECUTION_ENVIRONMENT_GEN2");
assert.deepEqual(template.volumes, [{
  name: "workspace",
  csi: {
    driver: "gcsfuse.run.googleapis.com",
    readOnly: false,
    volumeAttributes: {
      bucketName: "mpw-1234567890-workspace1",
      mountOptions: ["only-dir=trees/42", ...FIXED_MOUNT_OPTIONS].join(","),
    },
  },
}]);
assert.deepEqual(template.containers, [{
  volumeMounts: [{name: "workspace", mountPath: "/workspace"}],
}]);
assert.equal(template.volumes[0].csi.volumeAttributes.mountOptions.includes("file-cache"), false);
assert.equal(template.volumes[0].csi.volumeAttributes.mountOptions.includes("negative-cache"), false);
assert.throws(() => buildSharedWorkspaceTemplate({bucketName: "archive-bucket"}), /descriptor_required/);
assert.throws(() => buildSharedWorkspaceTemplate({bucketName: "archive-bucket", storageGeneration: "trees/42"}), /generation/);
assert.throws(() => buildSharedWorkspaceTemplate({bucketName: "PrivateArchive", storageGeneration: "42"}), /bucket/);

console.log("shared workspace template helper tests passed");
