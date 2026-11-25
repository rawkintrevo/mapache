"use strict";

const {httpError} = require("./backendUtils.helpers");

const covers = (prefix, candidate) => typeof candidate === "string" &&
  (candidate === prefix || candidate.startsWith(prefix + "/"));

function resolveMigrationPrefix(workspace, ownerUid, defaultBucket) {
  const bucket = workspace.bucket || workspace.workspaceStorageBucket || defaultBucket;
  const prefix = workspace.storagePrefix || workspace.workspaceStoragePrefix;
  const match = typeof prefix === "string" && /^workspaces\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)$/.exec(prefix);
  if (!bucket || bucket !== defaultBucket || !match || match[1] !== ownerUid || [".", ".."].includes(match[2]) ||
      (workspace.workspaceStorageBucket && workspace.workspaceStorageBucket !== bucket) ||
      (workspace.workspaceStoragePrefix && workspace.workspaceStoragePrefix !== prefix) ||
      workspace.sharedStorage || (workspace.homePolicy?.storagePrefix &&
        (!covers(prefix, workspace.homePolicy.storagePrefix) || (workspace.homePolicy.bucket && workspace.homePolicy.bucket !== bucket)))) {
    throw httpError(409, "vm_migration_storage_scope_unverified");
  }
  return {bucket, prefix, workspaceKey: match[2]};
}

module.exports = {covers, resolveMigrationPrefix};
