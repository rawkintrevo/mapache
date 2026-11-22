"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  USER_TOOLS_BIN_PATH,
  USER_TOOLS_MOUNT_PATH,
  buildUserToolsStorageTemplate,
  prepareUserToolsStorage,
  userToolsStorageForOwner,
} = require("./userToolsStorage.service");

test("user tool storage is deterministic per owner and isolated between owners", () => {
  const first = userToolsStorageForOwner("user-a", {bucketName: "tools-bucket"});
  const sameOwner = userToolsStorageForOwner(" user-a ", {bucketName: "tools-bucket"});
  const otherOwner = userToolsStorageForOwner("user-b", {bucketName: "tools-bucket"});

  assert.deepEqual(first, sameOwner);
  assert.notEqual(first.prefix, otherOwner.prefix);
  assert.equal(first.mountPath, USER_TOOLS_MOUNT_PATH);
  assert.equal(first.binPath, USER_TOOLS_BIN_PATH);
  assert.match(first.prefix, /^mapache-user-tools\/[a-f0-9]{64}\/\.mapache-internal\/tools$/);
});

test("user tool storage prepares the complete mount and bin directories", async () => {
  const saves = [];
  const descriptor = userToolsStorageForOwner("user-a", {bucketName: "tools-bucket"});
  const storage = {
    bucket(bucketName) {
      assert.equal(bucketName, "tools-bucket");
      return {
        file(name) {
          return {
            async save(content, options) {
              saves.push({content, name, options});
            },
          };
        },
      };
    },
  };

  await prepareUserToolsStorage(descriptor, storage);

  assert.deepEqual(saves.map((entry) => entry.name), [
    `${descriptor.prefix}/`,
    `${descriptor.prefix}/bin/`,
  ]);
  assert.ok(saves.every((entry) => entry.content === "" && entry.options.preconditionOpts.ifGenerationMatch === 0));
});

test("user tool template mounts the owner-scoped tree read-write", () => {
  const descriptor = userToolsStorageForOwner("user-a", {bucketName: "tools-bucket"});
  const template = buildUserToolsStorageTemplate(descriptor);

  assert.equal(template.executionEnvironment, "EXECUTION_ENVIRONMENT_GEN2");
  assert.deepEqual(template.containers[0].volumeMounts, [{
    name: "user-tools",
    mountPath: "/root/.local",
  }]);
  assert.equal(template.volumes[0].gcs.bucket, "tools-bucket");
  assert.equal(template.volumes[0].gcs.readOnly, false);
  assert.ok(template.volumes[0].gcs.mountOptions.includes(`only-dir=${descriptor.prefix}`));
  assert.ok(template.volumes[0].gcs.mountOptions.includes("metadata-cache-ttl-secs=0"));
});
