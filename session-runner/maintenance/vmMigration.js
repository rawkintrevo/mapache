"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {prepareRetainedDisk} = require("../lib/retainedDiskStorage");

const LARGE_FILE_POINTER = "mapache-large-file-v1";

async function inventoryWorkspaceSources({workspaceId, ownerUid, sourceRoot, homeRoot, manifests = [], ssh = false, fsImpl = fs} = {}) {
  const report = {
    version: 1,
    workspaceId: String(workspaceId || ""),
    ownerUid: String(ownerUid || ""),
    sourceGeneration: null,
    categories: [],
    entries: [],
    bytes: 0,
    blockers: [],
    readOnly: true,
  };
  if (ssh) {
    report.categories.push("ssh-unsupported");
    report.blockers.push({code: "ssh_workspace_requires_manual_migration"});
    return report;
  }
  const roots = [{kind: "workspace", root: sourceRoot}, {kind: "home", root: homeRoot}].filter((entry) => entry.root);
  const manifestNames = manifests.map((manifest) => String(manifest?.format || manifest?.type || "").trim()).filter(Boolean);
  report.categories.push(...new Set(manifestNames.length ? manifestNames : ["filesystem"]));
  if (manifestNames.includes("workspace-bundle-v1")) report.sourceGeneration = manifests.find((manifest) => manifest.format === "workspace-bundle-v1")?.generation || null;
  for (const root of roots) {
    await walk(root.root, root.kind, root.root);
  }
  return report;

  async function walk(current, kind, base) {
    const stat = await fsImpl.promises.lstat(current).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) {
      report.blockers.push({code: "source_missing", kind});
      return;
    }
    const relative = path.relative(base, current).split(path.sep).join("/");
    if (stat.isSymbolicLink()) {
      const target = await fsImpl.promises.readlink(current);
      if (path.isAbsolute(target) || target.split(/[\\/]/).includes("..")) report.blockers.push({code: "unsafe_symlink", path: `${kind}/${relative}`});
      report.entries.push({kind, path: `${kind}/${relative}`, type: "symlink", target, mode: stat.mode & 0o777});
      return;
    }
    if (stat.isDirectory()) {
      if (relative) report.entries.push({kind, path: `${kind}/${relative}`, type: "directory", mode: stat.mode & 0o777});
      for (const entry of await fsImpl.promises.readdir(current)) await walk(path.join(current, entry), kind, base);
      return;
    }
    if (!stat.isFile()) {
      report.blockers.push({code: "unsupported_file_type", path: `${kind}/${relative}`});
      return;
    }
    const item = {kind, path: `${kind}/${relative}`, type: "file", bytes: stat.size, mode: stat.mode & 0o777};
    report.entries.push(item);
    report.bytes += stat.size;
    if (stat.size <= 256 && (await fsImpl.promises.readFile(current, "utf8").catch(() => "")).startsWith(LARGE_FILE_POINTER)) {
      report.blockers.push({code: "large_file_pointer_requires_resolution", path: item.path});
    }
  }
}

async function importWorkspaceToRetainedDisk({workspaceId, ownerUid, sourceRoot, homeRoot, destinationRoot, generation = 1, operationId, fsImpl = fs, journalPath} = {}) {
  const report = await inventoryWorkspaceSources({workspaceId, ownerUid, sourceRoot, homeRoot, fsImpl});
  if (report.blockers.length) return {state: "blocked", report};
  const prepared = await prepareRetainedDisk({root: destinationRoot, workspaceId, ownerUid, generation, operationId, fsImpl});
  const journalFile = journalPath || path.join(prepared.paths.root, ".mapache-internal", `migration-${operationId}.json`);
  await fsImpl.promises.mkdir(path.dirname(journalFile), {recursive: true, mode: 0o700});
  const journal = await readJson(journalFile, fsImpl) || {version: 1, operationId, entries: {}};
  for (const entry of report.entries) {
    if (entry.type === "directory") {
      await fsImpl.promises.mkdir(destinationPath(entry), {recursive: true, mode: entry.mode});
      continue;
    }
    const source = sourcePath(entry);
    const destination = destinationPath(entry);
    if (entry.type === "symlink") {
      await fsImpl.promises.mkdir(path.dirname(destination), {recursive: true, mode: 0o700});
      const existing = await fsImpl.promises.readlink(destination).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
      if (existing !== null && existing !== entry.target) throw migrationError("destination_conflict", entry.path);
      if (existing === null) await fsImpl.promises.symlink(entry.target, destination);
      journal.entries[entry.path] = {state: "copied", target: entry.target};
      continue;
    }
    const digest = await sha256(source, fsImpl);
    if (journal.entries[entry.path]?.sha256 === digest && await exists(destination, fsImpl)) continue;
    if (await exists(destination, fsImpl)) {
      const destinationDigest = await sha256(destination, fsImpl);
      if (destinationDigest !== digest) throw migrationError("destination_conflict", entry.path);
      journal.entries[entry.path] = {state: "copied", sha256: digest, bytes: entry.bytes};
      continue;
    }
    await fsImpl.promises.mkdir(path.dirname(destination), {recursive: true, mode: 0o700});
    await fsImpl.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    await fsImpl.promises.chmod(destination, entry.mode);
    journal.entries[entry.path] = {state: "copied", sha256: digest, bytes: entry.bytes};
    await writeJson(journalFile, journal, fsImpl);
  }
  journal.completedAt = new Date().toISOString();
  await writeJson(journalFile, journal, fsImpl);
  return {state: "ready", report, journalPath: journalFile, marker: prepared.marker};

  function sourcePath(entry) {
    const root = entry.kind === "home" ? homeRoot : sourceRoot;
    return path.join(root, entry.path.split("/").slice(1).join(path.sep));
  }
  function destinationPath(entry) {
    const root = entry.kind === "home" ? prepared.paths.home : prepared.paths.workspace;
    return path.join(root, entry.path.split("/").slice(1).join(path.sep));
  }
}

async function sha256(file, fsImpl = fs) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fsImpl.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function exists(file, fsImpl = fs) {
  return fsImpl.promises.access(file).then(() => true).catch((error) => error.code === "ENOENT" ? false : Promise.reject(error));
}

async function readJson(file, fsImpl) {
  try { return JSON.parse(await fsImpl.promises.readFile(file, "utf8")); } catch (error) { return error.code === "ENOENT" ? null : Promise.reject(error); }
}

async function writeJson(file, value, fsImpl) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fsImpl.promises.writeFile(temporary, `${JSON.stringify(value)}\n`, {mode: 0o600});
  await fsImpl.promises.rename(temporary, file);
}

function migrationError(code, pathValue) {
  const error = new Error(code);
  error.code = code;
  error.publicMessage = code;
  error.path = pathValue;
  return error;
}

module.exports = {inventoryWorkspaceSources, importWorkspaceToRetainedDisk, LARGE_FILE_POINTER};
