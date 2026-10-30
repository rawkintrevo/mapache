"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {pipeline} = require("node:stream/promises");
const {parsePointer, largeObjectPath, meter} = require("./workspaceLargeFiles");
const {readWorkspaceManifest, validateRelativePath} = require("./agentCheckpoint.service");

async function availableMemory(fsImpl = fs) {
  for (const [limitPath, usedPath] of [
    ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.current"],
    ["/sys/fs/cgroup/memory/memory.limit_in_bytes", "/sys/fs/cgroup/memory/memory.usage_in_bytes"],
  ]) {
    try {
      const [limit, used] = await Promise.all([limitPath, usedPath].map((p) => fsImpl.promises.readFile(p, "utf8")));
      if (Number.isFinite(Number(limit)) && Number(limit) > 0) return Number(limit) - Number(used);
    } catch (_) { /* Try the other cgroup layout. */ }
  }
  return null;
}

async function pullLargeFile({config, db, storage, requestedPath, fsImpl = fs, memoryAvailable = availableMemory}) {
  const root = await fsImpl.promises.realpath(config.workspaceDir);
  const target = path.resolve(process.cwd(), requestedPath);
  const relativePath = validateRelativePath(path.relative(root, target).split(path.sep).join("/"), "large file");
  // Do not follow any workspace symlink, including symlinked parent directories.
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    if ((await fsImpl.promises.lstat(current)).isSymbolicLink()) throw new Error("large_file_symlink_rejected");
  }
  const stat = await fsImpl.promises.stat(target);
  if (!stat.isFile() || stat.size > 1024) throw new Error("large_file_not_a_pointer");
  const originalContent = await fsImpl.promises.readFile(target);
  const descriptor = parsePointer(originalContent);
  if (!descriptor) throw new Error("large_file_not_a_pointer");
  const lockPath = path.join(path.dirname(root), ".mapache-large-file-pull.lock");
  const lock = await fsImpl.promises.open(lockPath, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST") throw new Error("large_file_pull_already_running");
    throw error;
  });
  const stage = path.join(path.dirname(root), `.mapache-large-file-${crypto.randomUUID()}`);
  try {
    const available = await memoryAvailable(fsImpl);
    if (available === null || available < descriptor.byteLength + 256 * 1024 * 1024) {
      throw new Error(`large_file_insufficient_memory: fetching needs ${descriptor.byteLength} bytes plus 256 MiB headroom; resize the runner first`);
    }
    const workspaceRef = db.collection("workspaces").doc(config.workspaceId);
    const authorityRef = config.runtimeKind === "automation" ? workspaceRef.collection("sessions").doc(config.sessionId) : workspaceRef;
    const snapshot = await authorityRef.get();
    const pointer = snapshot.data()?.agentRuntimeWorkspaceFiles;
    if (!pointer || pointer.manifest.bucketName !== config.bucketName) throw new Error("large_file_checkpoint_missing");
    const manifest = await readWorkspaceManifest({config, pointer, storage});
    const entry = manifest.files.find((item) => item.kind === "workspace-file" && item.sha256 === descriptor.sha256 &&
      Number(item.byteLength) === descriptor.byteLength);
    if (!entry) throw new Error("large_file_pointer_unrecognized");
    const objectPath = entry.storage === "large-file-v1" ? largeObjectPath(manifest.storagePrefix, descriptor) :
      `${manifest.storagePrefix}/workspace-files/${pointer.generation}/${pointer.bootInstanceId}/${pointer.captureId}/objects/${entry.path}`;
    const measured = meter(descriptor);
    await pipeline(storage.bucket(config.bucketName).file(objectPath).createReadStream(), measured.stream,
      fsImpl.createWriteStream(stage, {flags: "wx", mode: stat.mode & 0o777}));
    measured.result();
    // A failed/corrupt fetch or a concurrent edit must leave the pointer intact.
    const finalStat = await fsImpl.promises.lstat(target);
    if (finalStat.isSymbolicLink() || finalStat.ino !== stat.ino || finalStat.size !== originalContent.length ||
        await fsImpl.promises.realpath(target) !== target ||
        !(await fsImpl.promises.readFile(target)).equals(originalContent)) throw new Error("large_file_pointer_changed");
    await fsImpl.promises.rename(stage, target);
    return {path: relativePath, ...descriptor};
  } finally {
    await fsImpl.promises.rm(stage, {force: true});
    await lock.close();
    await fsImpl.promises.rm(lockPath, {force: true});
  }
}

module.exports = {availableMemory, pullLargeFile};
