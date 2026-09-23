"use strict";

const {DEFAULT_BUCKET} = require("./backendConfig");
const {httpError} = require("./backendUtils.helpers");
const {automationSessionId} = require("./runtimePaths.helpers");

const CHROME_PROFILE_SEED_SCHEMA_VERSION = 1;
const CHROME_PROFILE_SEED_STORAGE_DIR = "chrome-profile-seeds/v1";
const CHROME_PROFILE_SEED_CURRENT_NAME = "current.json";
const CHROME_PROFILE_SEED_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const CHROME_PROFILE_SEED_HASH_PATTERN = /^[a-f0-9]{64}$/;

function chromeProfileSeedPrefix(workspaceStoragePrefix) {
  const prefix = normalizeStoragePath(workspaceStoragePrefix);
  return prefix ? `${prefix}/.mapache-internal/${CHROME_PROFILE_SEED_STORAGE_DIR}` : "";
}

function chromeProfileSeedCurrentPath(workspaceStoragePrefix) {
  const prefix = chromeProfileSeedPrefix(workspaceStoragePrefix);
  return prefix ? `${prefix}/${CHROME_PROFILE_SEED_CURRENT_NAME}` : "";
}

function chromeProfileSeedVersionPrefix(workspaceStoragePrefix, version) {
  const prefix = chromeProfileSeedPrefix(workspaceStoragePrefix);
  const normalizedVersion = String(version || "").trim();
  if (!prefix || !CHROME_PROFILE_SEED_VERSION_PATTERN.test(normalizedVersion)) return "";
  return `${prefix}/versions/${normalizedVersion}`;
}

function chromeProfileSeedObjectPath(workspaceStoragePrefix, version) {
  const prefix = chromeProfileSeedVersionPrefix(workspaceStoragePrefix, version);
  return prefix ? `${prefix}/profile.tar.gz` : "";
}

function validateChromeProfileSeedDescriptor(value, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw seedError("chrome_profile_seed_descriptor_invalid");
  }
  const schemaVersion = Number(value.schemaVersion ?? value.version);
  const sourceWorkspaceId = String(value.sourceWorkspaceId || value.workspaceId || "").trim();
  const workspaceId = String(options.workspaceId || "").trim();
  const bucketName = String(value.bucketName || "").trim();
  const expectedBucket = String(options.bucketName || "").trim();
  const version = String(value.seedVersion || value.versionId || "").trim();
  const objectPath = String(value.objectPath || "").trim();
  const expectedPrefix = chromeProfileSeedPrefix(options.workspaceStoragePrefix);
  const capturedAt = String(value.capturedAt || "").trim();
  const byteLength = Number(value.byteLength);
  const sha256 = String(value.sha256 || "").trim().toLowerCase();
  const objectGeneration = String(value.objectGeneration || "").trim();

  if (schemaVersion !== CHROME_PROFILE_SEED_SCHEMA_VERSION ||
      !sourceWorkspaceId || workspaceId && sourceWorkspaceId !== workspaceId ||
      !bucketName || expectedBucket && bucketName !== expectedBucket ||
      !CHROME_PROFILE_SEED_VERSION_PATTERN.test(version) ||
      !expectedPrefix || !objectPath.startsWith(`${expectedPrefix}/versions/${version}/`) ||
      objectPath !== chromeProfileSeedObjectPath(options.workspaceStoragePrefix, version) ||
      !capturedAt || !Number.isFinite(Date.parse(capturedAt)) ||
      !Number.isSafeInteger(byteLength) || byteLength < 0 ||
      !CHROME_PROFILE_SEED_HASH_PATTERN.test(sha256) ||
      !/^\d+$/.test(objectGeneration)) {
    throw seedError("chrome_profile_seed_descriptor_invalid");
  }

  return {
    schemaVersion,
    kind: "mapache-chrome-profile-seed",
    sourceWorkspaceId,
    bucketName,
    seedVersion: version,
    objectPath,
    objectGeneration,
    byteLength,
    sha256,
    capturedAt: new Date(capturedAt).toISOString(),
    browser: safeBrowserMetadata(value.browser),
  };
}

async function selectAutomationChromeProfileSeed({
  run = {},
  sessionCollection,
  storage,
  workspace = {},
} = {}) {
  const bucketName = String(workspace.bucket || workspace.workspaceStorageBucket || DEFAULT_BUCKET || "").trim();
  const workspaceStoragePrefix = String(workspace.storagePrefix || workspace.workspaceStoragePrefix || "").trim();
  const context = {bucketName, workspaceId: workspace.id || run.workspaceId, workspaceStoragePrefix};

  if (run.chromeProfileSeed) {
    const descriptor = validateChromeProfileSeedDescriptor(run.chromeProfileSeed, context);
    await verifyChromeProfileSeedObject(descriptor, {storage});
    return inheritedSeed(descriptor, "pinned");
  }

  const existingAutomationSelection = await readExistingAutomationSelection(
      sessionCollection,
      workspace.id || run.workspaceId,
      run.runId,
  );
  if (existingAutomationSelection) {
    if (existingAutomationSelection.chromeProfileSeed) {
      const descriptor = validateChromeProfileSeedDescriptor(existingAutomationSelection.chromeProfileSeed, context);
      await verifyChromeProfileSeedObject(descriptor, {storage});
      return inheritedSeed(descriptor, "pinned");
    }
    if (existingAutomationSelection.chromeProfileInitialization?.mode === "fresh") {
      return {mode: "fresh", reason: "no_seed", descriptor: null, ageMs: null};
    }
    if (existingAutomationSelection.chromeProfileInitialization?.mode === "inherited") {
      throw seedError("chrome_profile_seed_unavailable");
    }
  }

  if (run.chromeProfileInitialization?.mode === "fresh") {
    return {mode: "fresh", reason: "no_seed", descriptor: null, ageMs: null};
  }
  if (run.chromeProfileInitialization?.mode === "inherited") {
    throw seedError("chrome_profile_seed_unavailable");
  }

  // Ordinary run startup selects the last complete immutable snapshot. Profile
  // refresh is a separate runner operation, so a changing live browser cannot
  // make automation provisioning fail or change the selected identity midway.
  const current = await readCurrentChromeProfileSeed({storage, ...context});
  if (!current) return {mode: "fresh", reason: "no_seed", descriptor: null, ageMs: null};
  return inheritedSeed(current, "latest_published");
}

async function readCurrentChromeProfileSeed({storage, bucketName, workspaceId, workspaceStoragePrefix} = {}) {
  const currentPath = chromeProfileSeedCurrentPath(workspaceStoragePrefix);
  if (!storage || !bucketName || !currentPath) return null;
  let content;
  try {
    [content] = await storage.bucket(bucketName).file(currentPath).download();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw normalizeSeedError(error, "chrome_profile_seed_unavailable");
  }
  let descriptor;
  try {
    descriptor = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw seedError("chrome_profile_seed_descriptor_invalid", error);
  }
  const normalized = validateChromeProfileSeedDescriptor(descriptor, {
    bucketName,
    workspaceId,
    workspaceStoragePrefix,
  });
  await verifyChromeProfileSeedObject(normalized, {storage});
  return normalized;
}

async function verifyChromeProfileSeedObject(descriptor, {storage} = {}) {
  if (!storage) throw seedError("chrome_profile_seed_unavailable");
  const file = storage.bucket(descriptor.bucketName).file(descriptor.objectPath);
  let metadata;
  try {
    [metadata] = await file.getMetadata();
  } catch (error) {
    if (isNotFound(error)) throw seedError("chrome_profile_seed_object_missing", error);
    throw normalizeSeedError(error, "chrome_profile_seed_unavailable");
  }
  if (String(metadata.generation || "") !== descriptor.objectGeneration ||
      Number(metadata.size) !== descriptor.byteLength) {
    throw seedError("chrome_profile_seed_checksum_mismatch");
  }
  if (typeof file.download === "function") {
    let content;
    try {
      [content] = await file.download();
    } catch (error) {
      if (isNotFound(error)) throw seedError("chrome_profile_seed_object_missing", error);
      throw normalizeSeedError(error, "chrome_profile_seed_unavailable");
    }
    if (content.length !== descriptor.byteLength ||
        require("node:crypto").createHash("sha256").update(content).digest("hex") !== descriptor.sha256) {
      throw seedError("chrome_profile_seed_checksum_mismatch");
    }
  }
  return descriptor;
}

async function readExistingAutomationSelection(sessionCollection, workspaceId, runId) {
  if (typeof sessionCollection !== "function" || !workspaceId || !runId) return null;
  const collection = sessionCollection(workspaceId);
  if (!collection || typeof collection.doc !== "function") return null;
  const sessionRef = collection.doc(automationSessionId(runId));
  if (!sessionRef || typeof sessionRef.get !== "function") return null;
  const snapshot = await sessionRef.get();
  return snapshot?.exists ? snapshot.data() || {} : null;
}

function inheritedSeed(descriptor, reason) {
  return {
    mode: "inherited",
    reason,
    descriptor,
    ageMs: Math.max(0, Date.now() - Date.parse(descriptor.capturedAt)),
  };
}

function safeBrowserMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
      .filter(([key, item]) => ["family", "version", "image", "runtime"].includes(key) &&
        (typeof item === "string" || typeof item === "number"))
      .map(([key, item]) => [key, String(item).slice(0, 128)]));
}

function normalizeStoragePath(value) {
  const normalized = String(value || "").replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
  return normalized && !normalized.split("/").some((part) => !part || part === "." || part === "..") ? normalized : "";
}

function isNotFound(error) {
  return Number(error?.code) === 404 || error?.code === "ENOENT";
}

function normalizeSeedError(error, fallback) {
  if (error?.code && /^chrome_profile_[a-z0-9_]+$/.test(String(error.code))) return error;
  return seedError(fallback, error);
}

function seedError(code, cause) {
  const error = httpError(503, code, cause);
  error.code = code;
  return error;
}

module.exports = {
  CHROME_PROFILE_SEED_CURRENT_NAME,
  CHROME_PROFILE_SEED_SCHEMA_VERSION,
  CHROME_PROFILE_SEED_STORAGE_DIR,
  chromeProfileSeedCurrentPath,
  chromeProfileSeedObjectPath,
  chromeProfileSeedPrefix,
  chromeProfileSeedVersionPrefix,
  readCurrentChromeProfileSeed,
  selectAutomationChromeProfileSeed,
  validateChromeProfileSeedDescriptor,
  verifyChromeProfileSeedObject,
};
