"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {secretFileInventory} = require("./workspaceAuth.service");

const MANIFEST_VERSION = 1;
const SNAPSHOT_STORAGE_DIR = "agent-snapshots/v1";
const MAX_SOURCE_READ_ATTEMPTS = 3;
const SAFE_PI_SETTING_FILES = new Set(["settings.json", "keybindings.json"]);
const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".cache",
  "cache",
  "Cache",
  "Code Cache",
  "GPUCache",
  "Crashpad",
  "Crash Reports",
  "node_modules",
  "tmp",
  "logs",
  "log",
  "runtime",
  "process",
]);

/**
 * The storage namespace is deliberately separate from the existing flat
 * archives. Task 15 may append an immutable capture id below this prefix,
 * while this task only creates a local staging directory.
 */
function agentSnapshotStoragePrefix(config = {}) {
  const prefix = normalizeRemotePart(config.prefix);
  if (!prefix) return "";
  const internal = normalizeRemotePart(config.internalStorageDir || ".mapache-internal");
  return [prefix, internal, SNAPSHOT_STORAGE_DIR].filter(Boolean).join("/");
}

function createAgentSnapshotService({
  config = {},
  fsImpl = fs,
  now = () => Date.now(),
  secretInventory = secretFileInventory(config),
} = {}) {
  const enabled = config.agentRuntimeEnabled === true || config.agentUiVersion === "pi-web-ui-v1";

  return {
    enabled: () => enabled,
    storagePrefix: () => agentSnapshotStoragePrefix(config),
    capture: (options = {}) => {
      if (!enabled && options.allowUnmarked !== true) {
        return Promise.resolve({enabled: false, skipped: true, storagePrefix: agentSnapshotStoragePrefix(config)});
      }
      return captureAgentSnapshot({
        ...options,
        config,
        fsImpl,
        now,
        secretInventory,
      });
    },
  };
}

/**
 * Capture the complete persistent agent state into a caller-owned staging
 * directory. This function never reads or writes Cloud Storage and never
 * mutates a Firestore checkpoint pointer.
 */
async function captureAgentSnapshot({
  config = {},
  stagingDir,
  stagingRoot,
  workspaceId = config.workspaceId,
  sessionId = config.sessionId,
  generation = config.agentRuntimeGeneration,
  bootInstanceId,
  capturedAt,
  now = () => Date.now(),
  fsImpl = fs,
  secretInventory = secretFileInventory(config),
  beforeAccept,
} = {}) {
  const identity = normalizeIdentity({workspaceId, sessionId, generation, bootInstanceId});
  const storagePrefix = agentSnapshotStoragePrefix(config);
  const ownsStaging = !stagingDir;
  const destination = path.resolve(stagingDir || await makeStagingDir(fsImpl, stagingRoot || config.agentStateRoot));
  const exclusions = buildExclusionSet(secretInventory);
  const sources = [];
  const uploadReferences = new Set();
  const records = [];
  const uploadsRoot = path.resolve(config.piWebUiDataDir || "", "uploads");

  await fsImpl.promises.mkdir(destination, {recursive: true, mode: 0o700});
  try {
    await captureSource({
      fsImpl,
      root: config.piSessionDir,
      outputRoot: destination,
      outputPrefix: "sessions",
      sourceKind: "transcript",
      includeFile: (relative) => path.posix.extname(relative).toLowerCase() === ".jsonl",
      uploadRoot: uploadsRoot,
      exclusions,
      sources,
      uploadReferences,
      records,
    });
    await captureSource({
      fsImpl,
      root: config.piAgentDir,
      outputRoot: destination,
      outputPrefix: "pi",
      sourceKind: "pi-setting",
      includeFile: (relative) => SAFE_PI_SETTING_FILES.has(path.posix.basename(relative)),
      uploadRoot: uploadsRoot,
      exclusions,
      sources,
      uploadReferences,
      records,
    });
    await captureSource({
      fsImpl,
      root: config.piWebUiDataDir,
      outputRoot: destination,
      outputPrefix: "ui",
      sourceKind: "ui-state",
      includeFile: (relative) => relative !== "uploads" && !relative.startsWith("uploads/"),
      uploadRoot: uploadsRoot,
      exclusions,
      sources,
      uploadReferences,
      records,
    });

    await captureReferencedUploads({
      fsImpl,
      uploadsRoot,
      outputRoot: destination,
      uploadReferences,
      exclusions,
      sources,
    });

    const manifest = {
      manifestVersion: MANIFEST_VERSION,
      kind: "mapache-agent-state-snapshot",
      storagePrefix,
      workspaceId: identity.workspaceId,
      sessionId: identity.sessionId,
      generation: identity.generation,
      bootInstanceId: identity.bootInstanceId,
      capturedAt: toIsoTimestamp(capturedAt || now()),
      files: sources.map(({sourcePath: _sourcePath, sourceSignature: _sourceSignature, ...entry}) => entry)
          .sort((a, b) => a.path.localeCompare(b.path)),
      exclusions: [...new Set(exclusions.reasons)].sort(),
    };

    await beforeAccept?.({manifest, stagingDir: destination});
    await verifySources({fsImpl, sources});
    const manifestPath = path.join(destination, "manifest.json");
    await writeJsonAtomically(fsImpl, manifestPath, manifest, 0o600);
    return {
      enabled: true,
      manifest,
      manifestPath,
      stagingDir: destination,
      storagePrefix,
    };
  } catch (error) {
    if (ownsStaging) await fsImpl.promises.rm(destination, {recursive: true, force: true}).catch(() => {});
    throw error;
  }
}

async function captureSource({
  fsImpl,
  root,
  outputRoot,
  outputPrefix,
  sourceKind,
  includeFile,
  uploadRoot,
  exclusions,
  sources,
  uploadReferences,
  records,
}) {
  if (!root) return;
  const resolvedRoot = path.resolve(root);
  let rootStat;
  try {
    rootStat = await fsImpl.promises.lstat(resolvedRoot);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw snapshotError("snapshot_source_invalid", `Snapshot source is not a directory: ${outputPrefix}`);
  }
  await walkSource({
    fsImpl,
    root: resolvedRoot,
    currentDir: resolvedRoot,
    outputRoot,
    outputPrefix,
    sourceKind,
    includeFile,
    uploadRoot,
    exclusions,
    sources,
    uploadReferences,
    records,
  });
}

async function walkSource({
  fsImpl,
  root,
  currentDir,
  outputRoot,
  outputPrefix,
  sourceKind,
  includeFile,
  uploadRoot,
  exclusions,
  sources,
  uploadReferences,
  records,
}) {
  let entries;
  try {
    entries = await fsImpl.promises.readdir(currentDir, {withFileTypes: true});
  } catch (error) {
    throw snapshotError("snapshot_source_changed", `Snapshot source became unreadable: ${outputPrefix}`,
        error);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const sourcePath = path.join(currentDir, entry.name);
    const relative = toRelativePath(root, sourcePath);
    const exclusion = exclusionReason(sourcePath, relative, sourceKind, exclusions);
    if (exclusion) {
      exclusions.reasons.push(exclusion);
      continue;
    }
    const stat = await fsImpl.promises.lstat(sourcePath);
    if (stat.isSymbolicLink()) {
      if (!includeFile(relative)) continue;
      await captureSymlink({
        fsImpl,
        root,
        sourcePath,
        relative,
        outputRoot,
        outputPrefix,
        sourceKind,
        stat,
        exclusions,
        sources,
      });
      continue;
    }
    if (stat.isDirectory()) {
      await walkSource({
        fsImpl,
        root,
        currentDir: sourcePath,
        outputRoot,
        outputPrefix,
        sourceKind,
        includeFile,
        uploadRoot,
        exclusions,
        sources,
        uploadReferences,
        records,
      });
      continue;
    }
    if (!stat.isFile() || !includeFile(relative)) continue;

    const read = await readStableFile(fsImpl, sourcePath);
    let content = read.content;
    let parsedRecords = [];
    let truncatedRecords = false;
    if (sourceKind === "transcript") {
      const parsed = parseCompleteJsonl(content, sourcePath);
      content = parsed.content;
      parsedRecords = parsed.records;
      truncatedRecords = parsed.truncated;
      for (const record of parsedRecords) {
        collectUploadReferences(record, uploadRoot, uploadReferences);
      }
    } else if (isJsonPath(relative)) {
      parseJsonSettings(content, sourcePath);
    }
    await writeStagedFile(fsImpl, outputRoot, path.join(outputPrefix, relative), content, stat.mode & 0o777);
    const entryRecord = manifestFile({
      path: path.join(outputPrefix, relative),
      kind: kindForSource(sourceKind),
      content,
      stat,
      completeRecords: sourceKind === "transcript" ? !truncatedRecords : undefined,
      recordCount: sourceKind === "transcript" ? parsedRecords.length : undefined,
    });
    sources.push({
      ...entryRecord,
      sourcePath,
      sourceSignature: read.signature,
    });
    records.push(...parsedRecords);
  }
}

async function captureReferencedUploads({
  fsImpl,
  uploadsRoot,
  outputRoot,
  uploadReferences,
  exclusions,
  sources,
}) {
  if (!uploadReferences.size) return;
  let rootStat;
  try {
    rootStat = await fsImpl.promises.lstat(uploadsRoot);
  } catch (error) {
    throw snapshotError("snapshot_attachment_missing", "Referenced upload directory is missing", error);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw snapshotError("snapshot_unsafe_symlink", "Upload directory must be a real directory");
  }
  const rootRealPath = await realpathInside(fsImpl, uploadsRoot);
  for (const reference of [...uploadReferences].sort()) {
    const relative = safeUploadRelativePath(uploadsRoot, reference);
    const sourcePath = path.resolve(uploadsRoot, relative);
    const stat = await fsImpl.promises.lstat(sourcePath).catch((error) => {
      throw snapshotError("snapshot_attachment_missing", `Referenced upload is missing: ${relative}`, error);
    });
    if (stat.isSymbolicLink()) {
      throw snapshotError("snapshot_unsafe_symlink", `Referenced upload is a symlink: ${relative}`);
    }
    if (!stat.isFile()) {
      throw snapshotError("snapshot_attachment_missing", `Referenced upload is not a file: ${relative}`);
    }
    const realPath = await realpathInside(fsImpl, sourcePath);
    if (!isPathInside(rootRealPath, realPath)) {
      throw snapshotError("snapshot_unsafe_symlink", `Referenced upload escapes its root: ${relative}`);
    }
    const read = await readStableFile(fsImpl, sourcePath);
    await writeStagedFile(fsImpl, outputRoot, path.join("uploads", relative), read.content, stat.mode & 0o777);
    sources.push({
      ...manifestFile({
        path: path.join("uploads", relative),
        kind: "attachment",
        content: read.content,
        stat,
      }),
      sourcePath,
      sourceSignature: read.signature,
    });
  }
  // This set is intentionally only used to drive the copy. Keeping exclusion
  // reasons separate prevents absolute credential/upload paths leaking into
  // the manifest.
  void exclusions;
}

async function captureSymlink({
  fsImpl,
  root,
  sourcePath,
  relative,
  outputRoot,
  outputPrefix,
  sourceKind,
  stat,
  exclusions,
  sources,
}) {
  const target = await fsImpl.promises.readlink(sourcePath);
  if (path.isAbsolute(target)) {
    throw snapshotError("snapshot_unsafe_symlink", `Absolute symlink is not portable: ${relative}`);
  }
  const targetPath = path.resolve(path.dirname(sourcePath), target);
  if (!isPathInside(root, targetPath)) {
    throw snapshotError("snapshot_unsafe_symlink", `Symlink escapes its source root: ${relative}`);
  }
  const rootRealPath = await realpathInside(fsImpl, root);
  const targetRealPath = await realpathInside(fsImpl, targetPath);
  if (!isPathInside(rootRealPath, targetRealPath)) {
    throw snapshotError("snapshot_unsafe_symlink", `Symlink resolves outside its source root: ${relative}`);
  }
  if (exclusions.paths.some((secretPath) =>
    isPathInside(secretPath, targetPath) || isPathInside(targetPath, secretPath))) {
    throw snapshotError("snapshot_secret_excluded", `Symlink points at excluded state: ${relative}`);
  }
  const stagedRelative = path.join(outputPrefix, relative);
  const stagedPath = path.join(outputRoot, stagedRelative);
  await fsImpl.promises.mkdir(path.dirname(stagedPath), {recursive: true});
  await fsImpl.promises.symlink(target, stagedPath);
  sources.push({
    path: normalizeStagedPath(stagedRelative),
    kind: kindForSource(sourceKind, true),
    byteLength: Buffer.byteLength(target, "utf8"),
    sha256: sha256(Buffer.from(target, "utf8")),
    mode: stat.mode & 0o777,
    target,
    sourcePath,
    sourceSignature: `${signature(stat)}\0${target}`,
  });
}

function buildExclusionSet(secretInventory) {
  const paths = [];
  for (const item of secretInventory || []) {
    if (item?.localPath) paths.push(path.resolve(item.localPath));
  }
  return {paths, reasons: []};
}

function exclusionReason(sourcePath, relative, sourceKind, exclusions) {
  const resolved = path.resolve(sourcePath);
  if (exclusions.paths.some((secretPath) => isPathInside(secretPath, resolved) || isPathInside(resolved, secretPath))) {
    return "secret-material";
  }
  const parts = relative.split("/").filter(Boolean);
  if (sourceKind === "ui-state" && parts[0] === "uploads") return "referenced-attachments-only";
  if (parts.some((part) => EXCLUDED_DIRECTORY_NAMES.has(part))) return "cache-or-process-state";
  const base = path.posix.basename(relative);
  if (sourceKind !== "transcript" && (base.endsWith(".lock") || base.endsWith(".pid") || base.endsWith(".sock"))) {
    return "lock-or-process-state";
  }
  if (sourceKind === "pi-setting" && !SAFE_PI_SETTING_FILES.has(base)) return "non-persistent-pi-config";
  if (sourceKind === "ui-state" && (base === "mcp.json" || base === "auth.json" || base === "credentials.json")) {
    return "credential-or-connector-state";
  }
  return "";
}

function kindForSource(sourceKind, symlink = false) {
  if (symlink) return "symlink";
  if (sourceKind === "transcript") return "pi-transcript";
  if (sourceKind === "pi-setting") return "pi-setting";
  return "ui-state";
}

function manifestFile({path: relativePath, kind, content, stat, completeRecords, recordCount}) {
  const entry = {
    path: normalizeStagedPath(relativePath),
    kind,
    byteLength: content.length,
    sha256: sha256(content),
    mode: stat.mode & 0o777,
  };
  if (completeRecords !== undefined) entry.completeRecords = completeRecords;
  if (recordCount !== undefined) entry.recordCount = recordCount;
  return entry;
}

async function readStableFile(fsImpl, sourcePath) {
  let lastSignature = "";
  for (let attempt = 0; attempt < MAX_SOURCE_READ_ATTEMPTS; attempt++) {
    const before = await fsImpl.promises.lstat(sourcePath).catch((error) => {
      throw snapshotError("snapshot_source_changed", `Snapshot source disappeared: ${sourcePath}`, error);
    });
    if (!before.isFile()) throw snapshotError("snapshot_source_invalid", `Snapshot source is not a file: ${sourcePath}`);
    const content = await fsImpl.promises.readFile(sourcePath);
    const after = await fsImpl.promises.lstat(sourcePath).catch((error) => {
      throw snapshotError("snapshot_source_changed", `Snapshot source changed: ${sourcePath}`, error);
    });
    const beforeSignature = signature(before);
    const afterSignature = signature(after);
    lastSignature = afterSignature;
    if (beforeSignature === afterSignature && after.isFile()) {
      return {content, signature: afterSignature};
    }
  }
  throw snapshotError("snapshot_source_changed", `Snapshot source kept changing: ${sourcePath}`, {lastSignature});
}

async function verifySources({fsImpl, sources}) {
  for (const source of sources) {
    const stat = await fsImpl.promises.lstat(source.sourcePath).catch((error) => {
      throw snapshotError("snapshot_source_changed", `Snapshot source disappeared: ${source.path}`, error);
    });
    let currentSignature = signature(stat);
    if (stat.isSymbolicLink()) {
      const target = await fsImpl.promises.readlink(source.sourcePath);
      currentSignature = `${currentSignature}\0${target}`;
    }
    if (currentSignature !== source.sourceSignature) {
      throw snapshotError("snapshot_source_changed", `Snapshot source changed during capture: ${source.path}`);
    }
  }
}

function parseCompleteJsonl(content, sourcePath) {
  const text = content.toString("utf8");
  const lines = text.split("\n");
  const hasTrailingNewline = text.endsWith("\n");
  const completeLines = [];
  const records = [];
  let truncated = false;
  const lastIndex = hasTrailingNewline ? lines.length - 2 : lines.length - 1;
  for (let index = 0; index <= lastIndex; index++) {
    const line = lines[index];
    if (!line.trim()) {
      completeLines.push(`${line}\n`);
      continue;
    }
    try {
      records.push(JSON.parse(line.replace(/\r$/, "")));
      completeLines.push(`${line}\n`);
    } catch (error) {
      if (!hasTrailingNewline && index === lastIndex) {
        truncated = true;
        break;
      }
      throw snapshotError("snapshot_malformed_jsonl", `Malformed JSONL record: ${sourcePath}`, error);
    }
  }
  if (!hasTrailingNewline && lastIndex >= 0 && !truncated) {
    const line = lines[lastIndex];
    if (line.trim()) {
      // The loop above has already accepted a valid final record; retain its
      // original no-newline form rather than manufacturing a different byte.
      completeLines[completeLines.length - 1] = line;
    }
  }
  return {content: Buffer.from(completeLines.join(""), "utf8"), records, truncated};
}

function parseJsonSettings(content, sourcePath) {
  try {
    const parsed = JSON.parse(content.toString("utf8"));
    // Upstream settings include both object-shaped state and valid array-shaped
    // catalogs (for example the seeded subagent-template list). Preserve either
    // JSON container while still rejecting null and scalar values.
    if (!parsed || typeof parsed !== "object") {
      throw new Error("JSON settings must be an object or array");
    }
  } catch (error) {
    throw snapshotError("snapshot_invalid_json", `Invalid JSON settings: ${sourcePath}`, error);
  }
}

function collectUploadReferences(value, uploadRoot, output, key = "") {
  if (typeof value === "string") {
    const candidates = [value];
    for (const match of value.matchAll(/(?:path|uploadPath)\s*=\s*["']([^"']+)["']/g)) {
      candidates.push(match[1]);
    }
    for (const candidate of candidates) {
      const normalized = candidate.replace(/\\/g, "/");
      if (key === "uploadPath" && !path.posix.isAbsolute(normalized)) {
        output.add(`${uploadRoot}/${normalized}`);
      } else if (uploadRoot && (normalized === uploadRoot || normalized.startsWith(`${uploadRoot}/`))) {
        output.add(normalized);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUploadReferences(item, uploadRoot, output, key);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    collectUploadReferences(childValue, uploadRoot, output, childKey);
  }
}

function safeUploadRelativePath(uploadsRoot, reference) {
  const normalized = String(reference || "").replace(/\\/g, "/");
  const root = path.resolve(uploadsRoot).replace(/\\/g, "/");
  if (!normalized.startsWith(`${root}/`)) {
    throw snapshotError("snapshot_path_traversal", "Upload reference is outside the configured upload root");
  }
  const relative = normalized.slice(root.length + 1);
  const parts = relative.split("/");
  if (!relative || parts.some((part) => !part || part === "." || part === "..")) {
    throw snapshotError("snapshot_path_traversal", "Upload reference contains an unsafe path");
  }
  return parts.join(path.sep);
}

async function realpathInside(fsImpl, target) {
  try {
    return await fsImpl.promises.realpath(target);
  } catch (error) {
    throw snapshotError("snapshot_unsafe_symlink", `Cannot verify snapshot path: ${target}`, error);
  }
}

function normalizeIdentity({workspaceId, sessionId, generation, bootInstanceId}) {
  const cleanWorkspaceId = String(workspaceId || "").trim();
  const cleanSessionId = String(sessionId || "").trim();
  const cleanBootInstanceId = String(bootInstanceId || "").trim();
  const cleanGeneration = Number(generation);
  if (!cleanWorkspaceId || !cleanSessionId || !cleanBootInstanceId ||
      !Number.isInteger(cleanGeneration) || cleanGeneration <= 0) {
    throw snapshotError("snapshot_identity_missing", "Snapshot identity requires workspace, session, generation, and boot instance");
  }
  return {
    workspaceId: cleanWorkspaceId,
    sessionId: cleanSessionId,
    generation: cleanGeneration,
    bootInstanceId: cleanBootInstanceId,
  };
}

function signature(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mode,
    stat.mtimeNs === undefined ? stat.mtimeMs : stat.mtimeNs,
    stat.ctimeNs === undefined ? stat.ctimeMs : stat.ctimeNs,
  ].map(String).join(":");
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function writeStagedFile(fsImpl, outputRoot, relativePath, content, mode) {
  const target = path.join(outputRoot, relativePath);
  await fsImpl.promises.mkdir(path.dirname(target), {recursive: true});
  const temporary = `${target}.partial-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    await fsImpl.promises.writeFile(temporary, content, {mode: 0o600});
    await fsImpl.promises.rename(temporary, target);
    await fsImpl.promises.chmod(target, mode).catch(() => {});
  } catch (error) {
    await fsImpl.promises.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function writeJsonAtomically(fsImpl, target, value, mode) {
  await writeStagedFile(fsImpl, path.dirname(target), path.basename(target),
      Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"), mode);
}

async function makeStagingDir(fsImpl, root) {
  const parent = path.resolve(root || os.tmpdir());
  await fsImpl.promises.mkdir(parent, {recursive: true, mode: 0o700});
  return fsImpl.promises.mkdtemp(path.join(parent, "snapshot-"));
}

function isJsonPath(relative) {
  return path.posix.extname(relative).toLowerCase() === ".json";
}

function toRelativePath(root, target) {
  const relative = path.relative(root || path.parse(target).root, target);
  return relative.split(path.sep).join("/").replace(/^\/+|\/+$/g, "");
}

function normalizeStagedPath(value) {
  return String(value || "").split(path.sep).join("/").replace(/^\/+|\/+$/g, "");
}

function isPathInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function normalizeRemotePart(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
}

function toIsoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw snapshotError("snapshot_timestamp_invalid", "Snapshot timestamp is invalid");
  return date.toISOString();
}

function snapshotError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

module.exports = {
  MANIFEST_VERSION,
  SNAPSHOT_STORAGE_DIR,
  agentSnapshotStoragePrefix,
  captureAgentSnapshot,
  collectUploadReferences,
  createAgentSnapshotService,
  parseCompleteJsonl,
  safeUploadRelativePath,
};
