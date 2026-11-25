"use strict";
const logger = require("firebase-functions/logger");
const {
  admin,
  db,
} = require("./backendContext");
const {
  DEFAULT_BUCKET,
  INTERNAL_STORAGE_DIR,
} = require("./backendConfig");
const {
  cleanName,
  httpError,
  normalizeStoragePrefix,
  serialize,
  slugify,
  sortByUpdatedAtDesc,
  timestampMillis,
  toClientDoc,
  userPath,
} = require("./backendUtils.helpers");
const {normalizeEnvMap} = require("./env.helpers");
const {
  normalizeMcpConfigPayload,
  normalizeStoredMcpConfig,
} = require("./mcpConfig.helpers");
const {AGENT_UI_VERSION} = require("./agentRuntime.helpers");
const {isMainRuntime} = require("./runtimePaths.helpers");
const {assertVmMigrationAdmission, hasVmMigrationFence} = require("./vmMigrationFence.helpers");
const {normalizeSessionResources} = require("./sessionResources.helpers");
const {
  COMPUTE_ENGINE_BACKEND,
  createRuntimeDescriptor,
} = require("./runtimeProvider.helpers");

const ACTIVE_SESSION_STATUSES = new Set([
  "running",
  "ready",
  "provisioning",
  "queued",
  "restarting",
  "resizing",
  "needs_service",
  "stopping",
]);

function createWorkspaceService(dependencies = {}) {
  return {
    createWorkspace: (uid, payload) => createWorkspace(uid, payload, dependencies),
    deleteWorkspace: (uid, workspaceId) => deleteWorkspace(uid, workspaceId, dependencies),
    getWorkspaceMcpConfig,
    listWorkspaces: (uid) => listWorkspaces(uid, dependencies),
    prepareWorkspaceStorageMigration: (uid, workspaceId) => dependencies.workspaceStorageMigrationService.prepare(uid, workspaceId),
    renameWorkspace: (uid, workspaceId, payload) => renameWorkspace(uid, workspaceId, payload, dependencies),
    saveWorkspaceMcpConfig: (uid, workspaceId, payload) => saveWorkspaceMcpConfig(uid, workspaceId, payload, dependencies),
  };
}

async function listWorkspaces(uid, dependencies = {}) {
  const workspaceDb = dependencies.db || db;
  const workspaceAdmin = dependencies.admin || admin;
  const snap = await workspaceDb.collection("workspaces")
      .where("ownerUid", "==", uid)
      .get();
  const workspaces = await Promise.all(snap.docs.filter((doc) => {
    const data = doc.data() || {};
    return !isWorkspaceDeleted(data) && !isWorkspaceMigrated(data);
  }).map((doc) =>
    ensureCanonicalSession(uid, doc, {db: workspaceDb, admin: workspaceAdmin}),
  ));
  return workspaces.filter(Boolean).map(serializeWorkspaceForClient).sort(sortByUpdatedAtDesc);
}

async function renameWorkspace(uid, workspaceId, payload, dependencies = {}) {
  const workspaceDb = dependencies.db || db;
  const workspaceAdmin = dependencies.admin || admin;
  const workspaceRef = workspaceDb.collection("workspaces").doc(workspaceId);
  await workspaceDb.runTransaction(async transaction => {
    const workspace = await readMutableWorkspace(transaction, workspaceRef, uid);
    await assertVmMigrationAdmission(transaction, workspaceDb, workspaceId);
    const name = cleanName(payload && payload.name);
    if (!name) throw httpError(400, "invalid_workspace_name");
    const updatedAt = workspaceAdmin.firestore.FieldValue.serverTimestamp();
    const update = {name, updatedAt};
    if (payload && Object.prototype.hasOwnProperty.call(payload, "resources")) {
      try {
        update.resources = normalizeSessionResources(payload.resources || {});
      } catch (error) {
        if (error?.code === "invalid_session_resources") throw httpError(400, error.code, error);
        throw error;
      }
      const canonical = await readCanonicalSession(transaction, workspaceRef, workspace);
      if ((workspace.canonicalSessionId || null) !== (canonical?.id ?? null)) {
        update.canonicalSessionId = canonical?.id ?? null;
      }
      if (canonical && !["queued", "running"].includes(canonical.resizeOperationState) &&
          !["running", "ready"].includes(String(canonical.status || "").toLowerCase())) {
        transaction.update(canonical.ref, {resources: update.resources, updatedAt});
      }
    }
    transaction.update(workspaceRef, update);
  });
  return serializeWorkspaceForClient(toClientDoc(await workspaceRef.get()));
}

async function readMutableWorkspace(transaction, reference, uid) {
  const snapshot = await transaction.get(reference);
  if (!snapshot.exists) throw httpError(404, "workspace_not_found");
  const workspace = snapshot.data() || {};
  if (workspace.ownerUid !== uid) throw httpError(403, "workspace_forbidden");
  assertWorkspaceMutable(workspace);
  return workspace;
}

async function getWorkspaceMcpConfig(uid, workspaceId) {
  const workspace = await requireWorkspace(uid, workspaceId);
  return normalizeStoredMcpConfig(workspace.mcpConfig || {});
}

async function saveWorkspaceMcpConfig(uid, workspaceId, payload, dependencies = {}) {
  const workspaceDb = dependencies.db || db;
  const workspaceAdmin = dependencies.admin || admin;
  const workspaceRef = workspaceDb.collection("workspaces").doc(workspaceId);
  return workspaceDb.runTransaction(async transaction => {
    await readMutableWorkspace(transaction, workspaceRef, uid);
    await assertVmMigrationAdmission(transaction, workspaceDb, workspaceId);
    const mcpConfig = normalizeMcpConfigPayload(payload);
    transaction.update(workspaceRef, {
      mcpConfig,
      updatedAt: workspaceAdmin.firestore.FieldValue.serverTimestamp(),
    });
    return mcpConfig;
  });
}

async function deleteWorkspace(uid, workspaceId, dependencies = {}) {
  if (typeof dependencies.workspaceAutomationDeletionService?.deleteWorkspace === "function") {
    return dependencies.workspaceAutomationDeletionService.deleteWorkspace(uid, workspaceId);
  }
  throw httpError(503, "workspace_deletion_unavailable");
}

async function createWorkspace(uid, payload, dependencies = {}) {
  payload = payload || {};
  const workspaceDb = dependencies.db || db;
  const workspaceAdmin = dependencies.admin || admin;
  const now = workspaceAdmin.firestore.FieldValue.serverTimestamp();
  const name = cleanName(payload.name || "Default workspace");
  const bucket = cleanName(payload.bucket || DEFAULT_BUCKET);
  const source = await normalizeWorkspaceSourcePayload(uid, payload, dependencies);
  let resources;
  try {
    resources = normalizeSessionResources(payload.resources || payload);
  } catch (error) {
    if (error && error.code === "invalid_session_resources") {
      throw httpError(400, error.code, error);
    }
    throw error;
  }
  const storagePrefix = `workspaces/${uid}/${slugify(name)}`;
  const publicSource = {...source};
  const doc = {
    ownerUid: uid,
    agentUiVersion: AGENT_UI_VERSION,
    userPath: userPath(uid),
    name,
    bucket,
    source: publicSource.type === "blank" ? {
      type: "blank",
      status: "ready",
      statusMessage: null,
      resolvedBranch: null,
      resolvedCommit: null,
    } : {
      ...publicSource,
      status: "pending",
      statusMessage: null,
      resolvedBranch: null,
      resolvedCommit: null,
    },
    syncPolicy: normalizeWorkspaceSyncPolicy(source),
    homePolicy: normalizeWorkspaceHomePolicy({bucket, storagePrefix}, payload.homePolicy || payload.home),
    env: normalizeEnvMap(payload.env, {
      errorCode: "invalid_workspace_env",
      invalidNameErrorCode: "invalid_workspace_env_name",
      reservedNameErrorCode: "reserved_workspace_env_name",
    }),
    environmentEntryIds: Array.isArray(payload.environmentEntryIds) ? [...new Set(payload.environmentEntryIds.map((id) => String(id || "").trim()).filter(Boolean))] : [],
    resources,
    canonicalSessionId: null,
    mcpConfig: normalizeMcpConfigPayload(payload.mcpConfig || {}),
    storagePrefix,
    createdAt: now,
    updatedAt: now,
  };
  const useComputeEngine = dependencies.runtimeProviderEnabled?.() === true;
  if (useComputeEngine) {
    doc.runtimeBackend = COMPUTE_ENGINE_BACKEND;
    doc.runtimeProviderVersion = 1;
  }
  const ref = await workspaceDb.collection("workspaces").add(doc);
  if (useComputeEngine) {
    await ref.update({runtimeProvider: createRuntimeDescriptor({
      backend: COMPUTE_ENGINE_BACKEND,
      workspaceId: ref.id,
      ownerUid: uid,
      region: process.env.SESSION_REGION || "us-central1",
      gateway: runtimeGatewayPayload(dependencies.runtimeGatewayBaseUrl?.()),
    })});
  }
  const snap = await ref.get();
  return toClientDoc(snap);
}

function runtimeGatewayPayload(value) {
  const baseUrl = String(value || process.env.VM_RUNTIME_GATEWAY_BASE_URL || "").trim();
  return baseUrl ? {baseUrl} : null;
}

async function normalizeWorkspaceSourcePayload(uid, payload, dependencies = {}) {
  let source = payload && Object.prototype.hasOwnProperty.call(payload, "source") ? payload.source : undefined;
  if (source === undefined || source === null || source === "") {
    return {type: "blank"};
  }
  if (typeof source === "string") {
    const sourceType = cleanName(source).toLowerCase();
    if (!sourceType || sourceType === "blank") {
      return {type: "blank"};
    }
    source = {
      type: sourceType,
      repoUrl: payload && (payload.repoUrl || payload.url),
      requestedBranch: payload && (payload.requestedBranch || payload.branch),
      requestedCommit: payload && (payload.requestedCommit || payload.commit),
    };
  }
  if (typeof source !== "object" || Array.isArray(source)) {
    throw httpError(400, "invalid_workspace_source");
  }

  const rawType = source.type == null ? (source.repoUrl || source.url ? "github" : "") : source.type;
  const type = cleanName(rawType).toLowerCase();
  if (!type) {
    throw httpError(400, "invalid_workspace_source_type");
  }
  if (type === "blank") {
    return {type: "blank"};
  }
  if (type === "ssh" || type === "dev-machine" || type === "dev-machine-backed") {
    throw httpError(400, "unsupported_workspace_source_type");
  }
  if (type !== "github") {
    throw httpError(400, "unsupported_workspace_source_type");
  }

  const requestedBranch = cleanName(source.requestedBranch || source.branch || "");
  const requestedCommit = cleanName(source.requestedCommit || source.commit || "");
  if (requestedCommit && !/^[0-9a-f]{7,40}$/i.test(requestedCommit)) {
    throw httpError(400, "invalid_workspace_source_commit");
  }

  const isConnectedGithubSourcePayload = dependencies.isConnectedGithubSourcePayload || (() => false);
  if (isConnectedGithubSourcePayload(source)) {
    return dependencies.normalizeConnectedGithubSourcePayload(uid, source, {
      requestedBranch,
      requestedCommit,
    });
  }

  const repoUrl = normalizePublicGitHubRepoUrl(source.repoUrl || source.url || "");
  const {owner, repo, cloneUrl} = parsePublicGitHubRepoUrl(repoUrl);
  return {
    type: "github",
    mode: "public",
    repoUrl: cloneUrl,
    owner,
    repo,
    requestedBranch: requestedBranch || null,
    requestedCommit: requestedCommit || null,
    visibility: "public",
  };
}

function normalizeWorkspaceSyncPolicy(source) {
  if (!source || source.type !== "github") {
    return {
      mode: "blank",
      exclude: [],
    };
  }

  return {
    mode: "github-cache",
    exclude: [
      ".git/",
      "node_modules/",
      "dist/",
      "build/",
      ".next/",
      ".mapache-internal/",
    ],
  };
}

function normalizeWorkspaceHomePolicy(workspace, value = {}) {
  if (value == null || value === "") value = {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "invalid_workspace_home_policy");
  }
  const mode = cleanName(value.mode || "persistent").toLowerCase();
  if (!["persistent", "ephemeral"].includes(mode)) {
    throw httpError(400, "unsupported_workspace_home_mode");
  }
  const path = normalizeHomePath(value.path || "/root");
  const bucket = cleanName(value.bucket || workspace.bucket || DEFAULT_BUCKET);
  const storagePrefix = normalizeStoragePrefix(
      value.storagePrefix ||
      `${workspace.storagePrefix}/${INTERNAL_STORAGE_DIR}/home`,
  );
  return {
    mode,
    path,
    bucket,
    storagePrefix: mode === "persistent" ? storagePrefix : "",
    archiveName: cleanName(value.archiveName || "home.tar.gz") || "home.tar.gz",
  };
}

function normalizeHomePath(value) {
  const path = cleanName(value || "/root");
  if (!path.startsWith("/") || path.includes("\0") || path.includes("..")) {
    throw httpError(400, "invalid_workspace_home_path");
  }
  return path.replace(/\/+$/, "") || "/root";
}

function normalizePublicGitHubRepoUrl(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw httpError(400, "missing_github_repo_url");
  }
  return String(value).trim();
}

function parsePublicGitHubRepoUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw httpError(400, "invalid_github_repo_url", error);
  }

  if (url.protocol !== "https:") {
    throw httpError(400, "github_repo_url_must_use_https");
  }
  if (url.username || url.password) {
    throw httpError(400, "github_repo_url_must_not_include_credentials");
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "github.com") {
    throw httpError(400, "unsupported_github_repo_host");
  }
  if (url.search || url.hash) {
    throw httpError(400, "invalid_github_repo_url");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw httpError(400, "invalid_github_repo_url");
  }

  let owner;
  let repoPath;
  try {
    owner = decodeURIComponent(parts[0]).trim();
    repoPath = decodeURIComponent(parts[1]).trim();
  } catch (error) {
    throw httpError(400, "invalid_github_repo_url", error);
  }
  const repo = repoPath.endsWith(".git") ? repoPath.slice(0, -4) : repoPath;
  if (!owner || !repo) {
    throw httpError(400, "invalid_github_repo_url");
  }
  if (owner.includes("/") || repo.includes("/")) {
    throw httpError(400, "invalid_github_repo_url");
  }

  return {
    owner,
    repo,
    cloneUrl: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`,
  };
}

async function deleteWorkspaceStorageIfUnshared(uid, workspace, dependencies = {}) {
  const workspaceDb = dependencies.db || db;
  const workspaceAdmin = dependencies.admin || admin;
  const bucketName = workspace.bucket || DEFAULT_BUCKET;
  const prefix = normalizeStoragePrefix(workspace.storagePrefix || "");
  if (!bucketName || !prefix) return;

  const sameOwnerSnap = await workspaceDb.collection("workspaces")
      .where("ownerUid", "==", uid)
      .get();
  const shared = sameOwnerSnap.docs.some((doc) => {
    if (doc.id === workspace.id) return false;
    const data = doc.data() || {};
    return (data.bucket || DEFAULT_BUCKET) === bucketName && normalizeStoragePrefix(data.storagePrefix || "") === prefix;
  });
  if (shared) {
    logger.warn("skipping shared workspace storage deletion", {workspaceId: workspace.id, bucketName, prefix});
    return;
  }

  await workspaceAdmin.storage().bucket(bucketName).deleteFiles({prefix: `${prefix}/`});
}

function serializeWorkspaceForClient(value) {
  const serialized = serialize(value);
  if (!serialized || typeof serialized !== "object" || Array.isArray(serialized)) return serialized;
  if (serialized.sharedStorage) {
    serialized.sharedStorage = {
      configured: Boolean(serialized.sharedStorage.bucketName),
      state: serialized.sharedStorage.state || serialized.sharedStorageState || "legacy",
      errorCode: serialized.sharedStorage.errorCode || serialized.sharedStorageErrorCode || null,
    };
  }
  if (serialized.machineConfig) {
    const config = serialized.machineConfig;
    const desired = config.desired && typeof config.desired === "object" ? config.desired : {};
    serialized.machineConfig = {
      version: Number(config.version) || 1,
      desiredVersion: Number(config.desiredVersion) || 0,
      appliedVersion: Number(config.appliedVersion) || 0,
      state: config.state || "applied",
      desired: {
        description: typeof desired.description === "string" ? desired.description : "",
        resources: desired.resources || null,
        diskSizeGb: desired.diskSizeGb != null && Number.isSafeInteger(Number(desired.diskSizeGb)) ? Number(desired.diskSizeGb) : null,
        idleStopMinutes: desired.idleStopMinutes ?? null,
        piAuthEntryId: desired.piAuthEntryId || null,
        environmentEntryIds: Array.isArray(desired.environmentEntryIds) ? desired.environmentEntryIds : [],
        googleConnectionId: desired.googleConnectionId || null,
        gatewayId: desired.gatewayId || null,
      },
      pending: Number(config.desiredVersion) !== Number(config.appliedVersion),
    };
  }
  delete serialized.sharedStorageOperationId;
  return serialized;
}

async function requireWorkspace(uid, workspaceId) {
  const snap = await db.collection("workspaces").doc(workspaceId).get();
  if (!snap.exists) throw httpError(404, "workspace_not_found");
  const data = snap.data();
  if (data.ownerUid !== uid) throw httpError(403, "workspace_forbidden");
  assertWorkspaceMutable(data);
  return {id: snap.id, ...data};
}

function isWorkspaceDeleted(workspace = {}) {
  return workspace.deleted === true || ["deleting", "deleted"].includes(
      String(workspace.lifecycle || workspace.status || "").trim().toLowerCase(),
  );
}

function assertWorkspaceMutable(workspace = {}) {
  if (isWorkspaceDeleted(workspace)) throw httpError(409, "workspace_deleted");
  if (isWorkspaceMigrated(workspace)) throw httpError(409, "workspace_migrated_to_vm");
}

function isWorkspaceMigrated(workspace = {}) {
  return workspace.migrationAuthority === "compute-engine";
}

async function ensureCanonicalSession(uid, workspaceDoc, dependencies = {}) {
  const workspaceDb = dependencies.db || db;
  const workspaceAdmin = dependencies.admin || admin;
  const workspaceRef = workspaceDoc.ref;
  return workspaceDb.runTransaction(async transaction => {
    const snapshot = await transaction.get(workspaceRef);
    if (!snapshot.exists) return null;
    const workspace = {id: snapshot.id, ...snapshot.data()};
    if (workspace.ownerUid !== uid) throw httpError(403, "workspace_forbidden");
    if (isWorkspaceDeleted(workspace)) return null;
    if (isWorkspaceMigrated(workspace)) return null;
    if (await hasVmMigrationFence(transaction, workspaceDb, snapshot.id)) return workspace;
    const canonical = await readCanonicalSession(transaction, workspaceRef, workspace);
    const canonicalSessionId = canonical?.id ?? null;
    if ((workspace.canonicalSessionId || null) !== canonicalSessionId) {
      transaction.update(workspaceRef, {
        canonicalSessionId,
        updatedAt: workspaceAdmin.firestore.FieldValue.serverTimestamp(),
      });
      workspace.canonicalSessionId = canonicalSessionId;
    }
    return workspace;
  });
}

async function readCanonicalSession(transaction, workspaceRef, workspace) {
  const sessionsSnap = await transaction.get(workspaceRef.collection("sessions"));
  const sessions = sessionsSnap.docs.map(doc => ({...doc.data(), id: doc.id, ref: doc.ref}));
  const mainSessions = sessions.filter(isMainRuntime);
  let canonical = workspace.canonicalSessionId ?
    mainSessions.find((session) => session.id === workspace.canonicalSessionId) : null;
  if (!canonical && mainSessions.length) {
    canonical = [...mainSessions].sort((left, right) => {
      const leftActive = ACTIVE_SESSION_STATUSES.has(String(left.status || "").toLowerCase()) ? 1 : 0;
      const rightActive = ACTIVE_SESSION_STATUSES.has(String(right.status || "").toLowerCase()) ? 1 : 0;
      if (leftActive !== rightActive) return rightActive - leftActive;
      return timestampMillis(right.updatedAt) - timestampMillis(left.updatedAt) || String(left.id).localeCompare(String(right.id));
    })[0];
  }

  return canonical;
}

function workspaceSessionCollection(workspaceId) {
  return db.collection("workspaces").doc(workspaceId).collection("sessions");
}

module.exports = {
  createWorkspaceService,
  deleteWorkspaceStorageIfUnshared,
  ensureCanonicalSession,
  listWorkspaces,
  getWorkspaceMcpConfig,
  normalizePublicGitHubRepoUrl,
  normalizeWorkspaceHomePolicy,
  normalizeWorkspaceSourcePayload,
  normalizeWorkspaceSyncPolicy,
  parsePublicGitHubRepoUrl,
  requireWorkspace,
  renameWorkspace,
  saveWorkspaceMcpConfig,
  isWorkspaceDeleted,
  isWorkspaceMigrated,
};
