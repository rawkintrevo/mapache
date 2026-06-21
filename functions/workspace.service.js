"use strict";

const logger = require("firebase-functions/logger");
const {
  admin,
  db,
} = require("./backendContext");
const {
  DEFAULT_BUCKET,
  DIRECTORY_MARKER_FILES,
  INTERNAL_STORAGE_DIR,
  MAX_WORKSPACE_TEXT_FILE_BYTES,
  MAX_WORKSPACE_UPLOAD_BYTES,
} = require("./backendConfig");
const {
  cleanContentType,
  cleanName,
  contentTypeForPath,
  httpError,
  normalizeStoragePrefix,
  safeContentDispositionFilename,
  slugify,
  sortByUpdatedAtDesc,
  toClientDoc,
  userPath,
  workspaceUploadBuffer,
} = require("./backendUtils.helpers");
const {normalizeEnvMap} = require("./env.helpers");
const {
  normalizeMcpConfigPayload,
  normalizeStoredMcpConfig,
} = require("./mcpConfig.helpers");
const {
  isDirectoryMarkerFileName,
  isInternalStorageDirName,
} = require("./runtimePaths.helpers");
const {normalizeSshSessionPayload} = require("./sshSession.helpers");

function createWorkspaceService(dependencies = {}) {
  return {
    createWorkspace: (uid, payload) => createWorkspace(uid, payload, dependencies),
    createWorkspaceFileDownloadUrl,
    deleteWorkspace: (uid, workspaceId) => deleteWorkspace(uid, workspaceId, dependencies),
    getWorkspaceMcpConfig,
    listWorkspaceFiles,
    listWorkspaces,
    readWorkspaceFile,
    saveWorkspaceMcpConfig,
    saveWorkspaceFile,
    uploadWorkspaceFile,
  };
}

async function listWorkspaces(uid) {
  const snap = await db.collection("workspaces")
      .where("ownerUid", "==", uid)
      .get();
  return snap.docs.map(toClientDoc).sort(sortByUpdatedAtDesc);
}

async function getWorkspaceMcpConfig(uid, workspaceId) {
  const workspace = await requireWorkspace(uid, workspaceId);
  return normalizeStoredMcpConfig(workspace.mcpConfig || {});
}

async function saveWorkspaceMcpConfig(uid, workspaceId, payload) {
  const workspaceRef = db.collection("workspaces").doc(workspaceId);
  const workspaceSnap = await workspaceRef.get();
  if (!workspaceSnap.exists) throw httpError(404, "workspace_not_found");
  const workspace = workspaceSnap.data() || {};
  if (workspace.ownerUid !== uid) throw httpError(403, "workspace_forbidden");

  const mcpConfig = normalizeMcpConfigPayload(payload);
  await workspaceRef.update({
    mcpConfig,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return mcpConfig;
}

async function deleteWorkspace(uid, workspaceId, dependencies = {}) {
  const workspaceRef = db.collection("workspaces").doc(workspaceId);
  const workspaceSnap = await workspaceRef.get();
  if (!workspaceSnap.exists) throw httpError(404, "workspace_not_found");
  const workspace = {id: workspaceSnap.id, ...workspaceSnap.data()};
  if (workspace.ownerUid !== uid) throw httpError(403, "workspace_forbidden");

  const sessionSnap = await workspaceSessionCollection(workspaceId).get();
  for (const sessionDoc of sessionSnap.docs) {
    const session = sessionDoc.data() || {};
    if (session.ownerUid && session.ownerUid !== uid) throw httpError(403, "session_forbidden");
    await sessionDoc.ref.update({
      status: "deleting",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const serviceDeleted = await dependencies.deleteSessionService(
        sessionDoc.ref,
        session,
        {reason: "workspace_deleted"},
    );
    if (!serviceDeleted) throw httpError(502, "workspace_delete_failed");
  }

  await deleteWorkspaceStorageIfUnshared(uid, workspace);
  await db.collection("users").doc(uid).collection("private").doc(`sshWorkspace_${workspaceId}`).delete().catch((error) => {
    logger.warn("ssh workspace auth cleanup failed", {workspaceId, error: error.message});
  });
  if (typeof db.recursiveDelete === "function") {
    await db.recursiveDelete(workspaceRef);
  } else {
    for (const sessionDoc of sessionSnap.docs) {
      await sessionDoc.ref.delete();
    }
    await workspaceRef.delete();
  }
  return {ok: true};
}

async function createWorkspace(uid, payload, dependencies = {}) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const name = cleanName(payload.name || "Default workspace");
  const bucket = cleanName(payload.bucket || DEFAULT_BUCKET);
  const source = await normalizeWorkspaceSourcePayload(uid, payload, dependencies);
  const storagePrefix = `workspaces/${uid}/${slugify(name)}`;
  const sourceSecrets = source.secrets || null;
  const publicSource = {...source};
  delete publicSource.secrets;
  const doc = {
    ownerUid: uid,
    userPath: userPath(uid),
    name,
    bucket,
    source: publicSource.type === "blank" ? {
      type: "blank",
      status: "ready",
      statusMessage: null,
      resolvedBranch: null,
      resolvedCommit: null,
    } : publicSource.type === "ssh" ? {
      ...publicSource,
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
    mcpConfig: normalizeMcpConfigPayload(payload.mcpConfig || {}),
    storagePrefix,
    createdAt: now,
    updatedAt: now,
  };
  const ref = await db.collection("workspaces").add(doc);
  if (sourceSecrets) {
    await db.collection("users").doc(uid).collection("private").doc(`sshWorkspace_${ref.id}`).set({
      ownerUid: uid,
      workspaceId: ref.id,
      type: "openssh-user-certificate",
      ...sourceSecrets,
      createdAt: now,
      updatedAt: now,
    });
  }
  const snap = await ref.get();
  return toClientDoc(snap);
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
    const normalized = normalizeSshSessionPayload({sshTarget: source.sshTarget || source.target || source});
    return {
      type: "ssh",
      mode: "dev-machine",
      target: normalized.public,
      secrets: normalized.secrets,
    };
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

async function deleteWorkspaceStorageIfUnshared(uid, workspace) {
  const bucketName = workspace.bucket || DEFAULT_BUCKET;
  const prefix = normalizeStoragePrefix(workspace.storagePrefix || "");
  if (!bucketName || !prefix) return;

  const sameOwnerSnap = await db.collection("workspaces")
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

  await admin.storage().bucket(bucketName).deleteFiles({prefix: `${prefix}/`});
}

async function listWorkspaceFiles(uid, workspaceId) {
  const workspace = await requireWorkspace(uid, workspaceId);
  const bucketName = workspace.bucket || DEFAULT_BUCKET;
  const prefix = normalizeStoragePrefix(workspace.storagePrefix || "");
  if (!bucketName || !prefix) return {files: [], truncated: false};

  const queryPrefix = `${prefix}/`;
  const [files, nextQuery] = await admin.storage().bucket(bucketName).getFiles({
    autoPaginate: false,
    maxResults: 500,
    prefix: queryPrefix,
  });

  return {
    files: files
        .map((file) => storageFileToClientFile(file, queryPrefix))
        .filter(Boolean)
        .sort((left, right) => left.path.localeCompare(right.path)),
    truncated: Boolean(nextQuery),
  };
}

async function readWorkspaceFile(uid, workspaceId, path) {
  const {file, relativePath} = await workspaceStorageFile(uid, workspaceId, path);
  const [exists] = await file.exists();
  if (!exists) throw httpError(404, "file_not_found");

  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size || 0);
  if (size > MAX_WORKSPACE_TEXT_FILE_BYTES) throw httpError(413, "file_too_large");

  const [buffer] = await file.download();
  return {
    path: relativePath,
    name: relativePath.split("/").pop(),
    content: buffer.toString("utf8"),
    contentType: metadata.contentType || "text/plain",
    size,
    updatedAt: metadata.updated || metadata.timeCreated || "",
  };
}

async function saveWorkspaceFile(uid, workspaceId, path, payload) {
  const {file, relativePath} = await workspaceStorageFile(uid, workspaceId, path);
  const content = String(payload.content ?? "");
  if (Buffer.byteLength(content, "utf8") > MAX_WORKSPACE_TEXT_FILE_BYTES) {
    throw httpError(413, "file_too_large");
  }

  await file.save(content, {
    contentType: contentTypeForPath(relativePath),
    resumable: false,
  });

  const [metadata] = await file.getMetadata();
  return {
    file: storageFileToClientFile(file, `${file.name.slice(0, -relativePath.length)}`),
    updatedAt: metadata.updated || metadata.timeCreated || "",
  };
}

async function uploadWorkspaceFile(uid, workspaceId, path, req) {
  const {file, relativePath} = await workspaceStorageFile(uid, workspaceId, path);
  const buffer = workspaceUploadBuffer(req);
  if (!buffer.length) throw httpError(400, "empty_file_upload");
  if (buffer.length > MAX_WORKSPACE_UPLOAD_BYTES) throw httpError(413, "file_too_large");

  await file.save(buffer, {
    contentType: cleanContentType(req.get("content-type")) || contentTypeForPath(relativePath),
    resumable: false,
  });

  const [metadata] = await file.getMetadata();
  return {
    file: storageFileToClientFile(file, `${file.name.slice(0, -relativePath.length)}`),
    updatedAt: metadata.updated || metadata.timeCreated || "",
  };
}

async function createWorkspaceFileDownloadUrl(uid, workspaceId, path) {
  const {file, relativePath} = await workspaceStorageFile(uid, workspaceId, path);
  const [exists] = await file.exists();
  if (!exists) throw httpError(404, "file_not_found");

  const expiresAtMs = Date.now() + 10 * 60 * 1000;
  const filename = relativePath.split("/").pop() || "download";
  const [url] = await file.getSignedUrl({
    action: "read",
    expires: expiresAtMs,
    responseDisposition: `attachment; filename="${safeContentDispositionFilename(filename)}"`,
    version: "v4",
  });

  return {
    ok: true,
    expiresAt: new Date(expiresAtMs).toISOString(),
    filename,
    url,
  };
}

async function requireWorkspace(uid, workspaceId) {
  const snap = await db.collection("workspaces").doc(workspaceId).get();
  if (!snap.exists) throw httpError(404, "workspace_not_found");
  const data = snap.data();
  if (data.ownerUid !== uid) throw httpError(403, "workspace_forbidden");
  return {id: snap.id, ...data};
}

function workspaceSessionCollection(workspaceId) {
  return db.collection("workspaces").doc(workspaceId).collection("sessions");
}

function storageFileToClientFile(file, queryPrefix) {
  const relativePath = file.name.slice(queryPrefix.length).replace(/^\/+/, "");
  if (!relativePath || relativePath.endsWith("/")) return null;
  if (isHiddenWorkspaceFilePath(relativePath)) {
    return null;
  }
  const directoryPath = workspaceDirectoryPathFromMarker(relativePath);
  if (directoryPath) {
    return {
      path: directoryPath,
      name: directoryPath.split("/").pop(),
      type: "directory",
      size: 0,
      updatedAt: "",
    };
  }
  const metadata = file.metadata || {};
  return {
    path: relativePath,
    name: relativePath.split("/").pop(),
    type: "file",
    size: Number(metadata.size || 0),
    updatedAt: metadata.updated || metadata.timeCreated || "",
  };
}

async function workspaceStorageFile(uid, workspaceId, path) {
  const workspace = await requireWorkspace(uid, workspaceId);
  const bucketName = workspace.bucket || DEFAULT_BUCKET;
  const prefix = normalizeStoragePrefix(workspace.storagePrefix || "");
  const relativePath = normalizeWorkspaceFilePath(path);
  if (!bucketName || !prefix) throw httpError(400, "workspace_storage_not_configured");
  return {
    file: admin.storage().bucket(bucketName).file(`${prefix}/${relativePath}`),
    relativePath,
  };
}

function normalizeWorkspaceFilePath(value) {
  const path = String(value || "").replace(/^\/+|\/+$/g, "");
  const parts = path.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw httpError(400, "invalid_file_path");
  }
  if (parts.some((part) => isDirectoryMarkerFileName(part))) {
    throw httpError(400, "invalid_file_path");
  }
  if (isHiddenWorkspaceFilePath(parts.join("/"))) {
    throw httpError(400, "invalid_file_path");
  }
  return parts.join("/");
}

function isHiddenWorkspaceFilePath(relativePath) {
  const parts = String(relativePath || "").split("/").filter(Boolean);
  if (isInternalStorageDirName(parts[0])) return true;
  return parts[0] === ".pi" && (parts[1] === "npm" || parts[1] === "git");
}

function workspaceDirectoryPathFromMarker(relativePath) {
  for (const marker of DIRECTORY_MARKER_FILES) {
    if (relativePath.endsWith(`/${marker}`)) {
      return relativePath.slice(0, -(`/${marker}`).length) || "";
    }
  }
  return "";
}

module.exports = {
  createWorkspaceService,
  deleteWorkspaceStorageIfUnshared,
  isHiddenWorkspaceFilePath,
  listWorkspaces,
  getWorkspaceMcpConfig,
  normalizePublicGitHubRepoUrl,
  normalizeWorkspaceFilePath,
  normalizeWorkspaceHomePolicy,
  normalizeWorkspaceSourcePayload,
  normalizeWorkspaceSyncPolicy,
  parsePublicGitHubRepoUrl,
  requireWorkspace,
  saveWorkspaceMcpConfig,
  storageFileToClientFile,
  workspaceStorageFile,
};
