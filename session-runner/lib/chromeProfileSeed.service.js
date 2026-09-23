"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {execFile} = require("node:child_process");
const {chromeProfileArchiveExcludePatterns} = require("./workspaceArchives.service");
const {isAutomationRuntime} = require("./runtimePaths");

const CHROME_PROFILE_SEED_SCHEMA_VERSION = 1;
const CHROME_PROFILE_SEED_STORAGE_DIR = "chrome-profile-seeds/v1";
const CURRENT_NAME = "current.json";
const MAX_CAPTURE_ATTEMPTS = 3;
const TRANSIENT_PROFILE_PATHS = new Set([
  "Crash Reports",
  "Default/Cache",
  "Default/Code Cache",
  "Default/Crashpad",
  "Default/Downloads",
  "Default/GPUCache",
  "Default/Service Worker/CacheStorage",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  "DevToolsActivePort",
  "tmp",
]);

function createChromeProfileSeedService({
  config = {},
  db,
  fsImpl = fs,
  execFileImpl = execFile,
  now = () => Date.now(),
  osImpl = os,
  profile,
  storage,
  randomId = () => crypto.randomUUID(),
  maxAttempts = MAX_CAPTURE_ATTEMPTS,
  retentionCount = 8,
} = {}) {
  const enabled = Boolean(config.chromeEnabled || config.runnerCapabilities?.chrome);
  const publisherEnabled = enabled && !isAutomationRuntime(config);
  let lastPublished = null;
  let lastError = null;
  let inFlight = null;

  return {
    enabled: () => enabled,
    publisherEnabled: () => publisherEnabled,
    publish: (options = {}) => publish(options),
    restore: () => restore(),
    status: () => ({
      enabled,
      publisherEnabled,
      lastPublished,
      error: lastError ? String(lastError.publicMessage || lastError.message || lastError) : null,
      inFlight: Boolean(inFlight),
    }),
  };

  async function publish({assertCurrentWriter, reason = "periodic"} = {}) {
    if (!publisherEnabled) return {enabled, skipped: true, reason: "private_runtime"};
    if (["reader", "none"].includes(String(config.workspaceSyncRole || "").trim().toLowerCase())) {
      return {enabled, skipped: true, reason: "sync_writer_lease"};
    }
    if (inFlight) return inFlight;
    inFlight = captureAndPublish({assertCurrentWriter, reason}).catch((error) => {
      lastError = error;
      throw error;
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function captureAndPublish({assertCurrentWriter, reason}) {
    await assertCurrentWriter?.();
    const bucketName = String(config.bucketName || "").trim();
    const prefix = normalizeStoragePath(config.prefix);
    if (!bucketName || !prefix || !storage) throw seedError("chrome_profile_capture_storage_unavailable");
    const source = path.resolve(config.chromeProfileDir || "");
    await fsImpl.promises.mkdir(source, {recursive: true, mode: 0o700});

    const stagingRoot = path.join(path.dirname(source), ".mapache-chrome-profile-seeds");
    await fsImpl.promises.mkdir(stagingRoot, {recursive: true, mode: 0o700});
    const captureId = cleanSegment(randomId());
    const archivePath = path.join(stagingRoot, `${captureId}.tar.gz`);
    let before;
    let after;
    try {
      for (let attempt = 0; attempt < Math.max(1, Number(maxAttempts) || MAX_CAPTURE_ATTEMPTS); attempt++) {
        await assertCurrentWriter?.();
        await flushFileSystem(execFileImpl);
        before = await profileSignature(source, fsImpl);
        await createArchive(source, archivePath, {execFileImpl});
        after = await profileSignature(source, fsImpl);
        if (before === after) break;
        if (attempt + 1 >= Math.max(1, Number(maxAttempts) || MAX_CAPTURE_ATTEMPTS)) {
          throw seedError("chrome_profile_capture_timeout");
        }
      }

      const archive = await fsImpl.promises.readFile(archivePath);
      const version = cleanSegment(`${now()}-${captureId}`);
      const objectPath = chromeProfileSeedObjectPath(prefix, version);
      const file = storage.bucket(bucketName).file(objectPath);
      await writeImmutableObject(file, archive);
      const metadata = await readObjectMetadata(file);
      const descriptor = {
        schemaVersion: CHROME_PROFILE_SEED_SCHEMA_VERSION,
        kind: "mapache-chrome-profile-seed",
        sourceWorkspaceId: String(config.workspaceId || "").trim(),
        bucketName,
        seedVersion: version,
        objectPath,
        objectGeneration: String(metadata.generation || "1"),
        byteLength: archive.length,
        sha256: sha256(archive),
        capturedAt: new Date(now()).toISOString(),
        browser: {
          family: "chromium",
          runtime: "pi-chrome",
        },
      };
      validateDescriptor(descriptor, {workspaceId: config.workspaceId, prefix, bucketName});
      const descriptorPath = `${chromeProfileSeedVersionPrefix(prefix, version)}/descriptor.json`;
      await writeImmutableObject(storage.bucket(bucketName).file(descriptorPath), Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`));
      const currentPath = `${chromeProfileSeedPrefix(prefix)}/${CURRENT_NAME}`;
      await storage.bucket(bucketName).file(currentPath).save(`${JSON.stringify(descriptor, null, 2)}\n`, {
        resumable: false,
        metadata: {contentType: "application/json", metadata: {mapacheChromeProfileSeed: "current"}},
      });
      await cleanupSupersededSeeds({bucketName, currentPath, currentVersion: version});
      lastPublished = {
        seedVersion: descriptor.seedVersion,
        capturedAt: descriptor.capturedAt,
        byteLength: descriptor.byteLength,
        reason,
      };
      lastError = null;
      return {enabled: true, descriptor, status: lastPublished};
    } finally {
      await fsImpl.promises.rm(archivePath, {force: true}).catch(() => {});
    }
  }

  async function cleanupSupersededSeeds({bucketName, currentPath, currentVersion}) {
    if (!db || typeof db.collection !== "function") return;
    const bucket = storage.bucket(bucketName);
    if (typeof bucket.getFiles !== "function") return;
    try {
      const runsQuery = db.collection("automationRuns");
      const scopedQuery = typeof runsQuery.where === "function" ?
        runsQuery.where("workspaceId", "==", config.workspaceId) : runsQuery;
      const runSnapshot = typeof scopedQuery.get === "function" ? await scopedQuery.get() : {docs: []};
      const referenced = new Set((runSnapshot.docs || []).map((doc) => doc.data?.()?.chromeProfileSeed?.seedVersion).filter(Boolean));
      const [files] = await bucket.getFiles({prefix: `${chromeProfileSeedPrefix(normalizeStoragePath(config.prefix))}/versions/`});
      const versions = new Map();
      for (const file of files || []) {
        const marker = "/versions/";
        const index = String(file.name || "").indexOf(marker);
        if (index < 0) continue;
        const version = String(file.name).slice(index + marker.length).split("/")[0];
        if (version) versions.set(version, [...(versions.get(version) || []), file]);
      }
      const keep = new Set([...versions.keys()].sort().reverse().slice(0, Math.max(1, Number(retentionCount) || 8)));
      keep.add(currentVersion);
      referenced.forEach((version) => keep.add(version));
      await Promise.all([...versions.entries()]
          .filter(([version]) => !keep.has(version))
          .flatMap(([, versionFiles]) => versionFiles.map((file) => file.delete?.({ignoreNotFound: true}))));
      void currentPath;
    } catch (error) {
      // Cleanup is best effort. The immutable object and current descriptor are
      // already valid, so retention failure must not invalidate a fresh seed.
    }
  }

  async function restore() {
    if (!enabled) return {enabled: false, mode: "disabled", restored: false};
    const strict = isAutomationRuntime(config);
    if (config.chromeProfileSeedConfigError) throw seedError(config.chromeProfileSeedConfigError);
    if (!storage) {
      if (config.chromeProfileSeed) throw seedError("chrome_profile_seed_unavailable");
      return {enabled: true, mode: strict ? "fresh" : "no_seed", reason: "no_seed", restored: false};
    }
    const descriptor = config.chromeProfileSeed || await readCurrentDescriptor();
    if (!descriptor) {
      if (strict) return {enabled: true, mode: "fresh", reason: "no_seed", restored: false};
      return {enabled: true, mode: "no_seed", reason: "no_seed", restored: false};
    }
    validateDescriptor(descriptor, {
      workspaceId: config.workspaceId,
      prefix: normalizeStoragePath(config.prefix),
      bucketName: config.bucketName,
    });
    const file = storage.bucket(descriptor.bucketName).file(descriptor.objectPath);
    const stagingRoot = path.join(path.dirname(config.chromeProfileDir), ".mapache-chrome-profile-seeds");
    await fsImpl.promises.mkdir(stagingRoot, {recursive: true, mode: 0o700});
    const archivePath = path.join(stagingRoot, `restore-${osImpl.pid || process.pid}-${cleanSegment(descriptor.seedVersion)}.tar.gz`);
    try {
      await file.download({destination: archivePath});
      const archive = await fsImpl.promises.readFile(archivePath);
      const metadata = await readObjectMetadata(file);
      if (String(metadata.generation || "") !== descriptor.objectGeneration ||
          Number(metadata.size) !== descriptor.byteLength || sha256(archive) !== descriptor.sha256) {
        throw seedError("chrome_profile_seed_checksum_mismatch");
      }
      const result = await profile.restoreArchive({
        createReadStream: () => fsImpl.createReadStream(archivePath),
        name: descriptor.objectPath,
      });
      return {
        enabled: true,
        mode: "inherited",
        reason: config.chromeProfileSeed ? "pinned" : "latest_published",
        restored: result.restored === true,
        descriptor: publicDescriptor(descriptor),
      };
    } catch (error) {
      const normalized = error.code && /^chrome_profile_/.test(error.code) ? error : seedError("chrome_profile_seed_restore_failed", error);
      lastError = normalized;
      throw normalized;
    } finally {
      await fsImpl.promises.rm(archivePath, {force: true}).catch(() => {});
    }
  }

  async function readCurrentDescriptor() {
    const bucketName = String(config.bucketName || "").trim();
    const currentPath = `${chromeProfileSeedPrefix(normalizeStoragePath(config.prefix))}/${CURRENT_NAME}`;
    if (!bucketName || !storage || currentPath === `${CURRENT_NAME}`) return null;
    let content;
    try {
      [content] = await storage.bucket(bucketName).file(currentPath).download();
    } catch (error) {
      if (Number(error?.code) === 404 || error?.code === "ENOENT") return null;
      throw seedError("chrome_profile_seed_unavailable", error);
    }
    try {
      return JSON.parse(content.toString("utf8"));
    } catch (error) {
      throw seedError("chrome_profile_seed_descriptor_invalid", error);
    }
  }
}

async function createArchive(source, archivePath, {execFileImpl}) {
  const args = [
    ...chromeProfileArchiveExcludePatterns().map((pattern) => `--exclude=${pattern}`),
    "--create", "--gzip", "--file", archivePath, "--directory", source, ".",
  ];
  await execFilePromise(execFileImpl, "tar", args, {timeout: 120000});
}

async function flushFileSystem(execFileImpl) {
  await execFilePromise(execFileImpl, "sync", [], {timeout: 5000});
}

function execFilePromise(execFileImpl, command, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, options, (error) => error ? reject(error) : resolve());
  });
}

async function profileSignature(root, fsImpl) {
  const entries = [];
  await walk(root, root, fsImpl, entries);
  return entries.sort().join("\n");
}

async function walk(root, current, fsImpl, entries) {
  const children = await fsImpl.promises.readdir(current, {withFileTypes: true});
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(current, child.name);
    const relative = path.relative(root, full).split(path.sep).join("/");
    if (isTransient(relative)) continue;
    const stat = await fsImpl.promises.lstat(full);
    entries.push(`${relative}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${child.isSymbolicLink() ? "l" : child.isDirectory() ? "d" : "f"}`);
    if (child.isDirectory()) await walk(root, full, fsImpl, entries);
  }
}

function isTransient(relative) {
  return [...TRANSIENT_PROFILE_PATHS].some((item) => relative === item || relative.startsWith(`${item}/`));
}

async function writeImmutableObject(file, content) {
  await file.save(content, {
    resumable: false,
    preconditionOpts: {ifGenerationMatch: 0},
    metadata: {
      contentType: "application/gzip",
      cacheControl: "no-store",
      metadata: {mapacheChromeProfileSeed: "immutable"},
    },
  });
}

async function readObjectMetadata(file) {
  const [metadata] = await file.getMetadata();
  return metadata || {};
}

function validateDescriptor(value, {workspaceId, prefix, bucketName} = {}) {
  const sourceWorkspaceId = String(value?.sourceWorkspaceId || "").trim();
  const version = String(value?.seedVersion || "").trim();
  const expectedPrefix = chromeProfileSeedPrefix(prefix);
  if (!value || value.schemaVersion !== CHROME_PROFILE_SEED_SCHEMA_VERSION ||
      value.kind !== "mapache-chrome-profile-seed" || !sourceWorkspaceId ||
      workspaceId && sourceWorkspaceId !== String(workspaceId) ||
      bucketName && value.bucketName !== String(bucketName) ||
      !/^\d+$/.test(String(value.objectGeneration || "")) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(version) ||
      !expectedPrefix || value.objectPath !== chromeProfileSeedObjectPath(prefix, version) ||
      !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 ||
      !/^[a-f0-9]{64}$/.test(String(value.sha256 || "")) ||
      !Number.isFinite(Date.parse(value.capturedAt))) {
    throw seedError("chrome_profile_seed_descriptor_invalid");
  }
  return true;
}

function publicDescriptor(value) {
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    sourceWorkspaceId: value.sourceWorkspaceId,
    seedVersion: value.seedVersion,
    objectGeneration: value.objectGeneration,
    byteLength: value.byteLength,
    sha256: value.sha256,
    capturedAt: value.capturedAt,
    browser: value.browser || {},
  };
}

function chromeProfileSeedPrefix(prefix) {
  const normalized = normalizeStoragePath(prefix);
  return normalized ? `${normalized}/.mapache-internal/${CHROME_PROFILE_SEED_STORAGE_DIR}` : "";
}

function chromeProfileSeedVersionPrefix(prefix, version) {
  const normalizedPrefix = chromeProfileSeedPrefix(prefix);
  return normalizedPrefix ? `${normalizedPrefix}/versions/${String(version || "")}` : "";
}

function chromeProfileSeedObjectPath(prefix, version) {
  const versionPrefix = chromeProfileSeedVersionPrefix(prefix, version);
  return versionPrefix ? `${versionPrefix}/profile.tar.gz` : "";
}

function normalizeStoragePath(value) {
  const normalized = String(value || "").replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
  return normalized && !normalized.split("/").some((part) => !part || part === "." || part === "..") ? normalized : "";
}

function cleanSegment(value) {
  return String(value || "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "seed";
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function seedError(code, cause) {
  const error = new Error(code);
  error.code = code;
  error.publicMessage = code;
  if (cause) error.cause = cause;
  return error;
}

module.exports = {
  CHROME_PROFILE_SEED_SCHEMA_VERSION,
  CHROME_PROFILE_SEED_STORAGE_DIR,
  chromeProfileSeedObjectPath,
  chromeProfileSeedPrefix,
  createChromeProfileSeedService,
  validateDescriptor,
};
