"use strict";

const admin = require("firebase-admin");
const crypto = require("crypto");
const {GoogleAuth} = require("google-auth-library");
const {onRequest} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {setGlobalOptions} = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");

admin.initializeApp();
setGlobalOptions({maxInstances: 10, region: process.env.FUNCTION_REGION || "us-central1"});

const db = admin.firestore();
const auth = new GoogleAuth({scopes: ["https://www.googleapis.com/auth/cloud-platform"]});

const DEFAULT_REGION = process.env.SESSION_REGION || "us-central1";
const DEFAULT_CPU = process.env.SESSION_CPU || "1";
const DEFAULT_MEMORY = process.env.SESSION_MEMORY || "1Gi";
const DEFAULT_IMAGE = process.env.SESSION_RUNNER_IMAGE || "";
const DEFAULT_BUCKET = process.env.SESSION_BUCKET || firebaseStorageBucket();
const DEFAULT_IDLE_TIMEOUT_MINUTES = positiveNumber(process.env.SESSION_IDLE_TIMEOUT_MINUTES, 60);
const DEFAULT_RUNNER_SHUTDOWN_TIMEOUT_MS = positiveNumber(
    process.env.RUNNER_SHUTDOWN_TIMEOUT_MS,
    120000,
);
const DIRECTORY_MARKER_FILE = ".mapahce-directory";
const INTERNAL_STORAGE_DIR = ".mapahce-internal";

exports.api = onRequest({cors: true}, async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    const user = await requireUser(req);
    const route = routeRequest(req.path);

    if (req.method === "GET" && route.name === "me") {
      res.json({user});
      return;
    }

    if (req.method === "GET" && route.name === "workspaces") {
      res.json({workspaces: await listWorkspaces(user.uid)});
      return;
    }

    if (req.method === "POST" && route.name === "workspaces") {
      res.status(201).json({workspace: await createWorkspace(user.uid, req.body || {})});
      return;
    }

    if (req.method === "GET" && route.name === "workspaceFiles") {
      res.json(await listWorkspaceFiles(user.uid, route.workspaceId));
      return;
    }

    if (req.method === "GET" && route.name === "workspaceFile") {
      res.json(await readWorkspaceFile(user.uid, route.workspaceId, req.query.path));
      return;
    }

    if (req.method === "PUT" && route.name === "workspaceFile") {
      res.json(await saveWorkspaceFile(user.uid, route.workspaceId, req.query.path, req.body || {}));
      return;
    }

    if (req.method === "GET" && route.name === "sessions") {
      res.json({sessions: await listSessions(user.uid, route.workspaceId)});
      return;
    }

    if (req.method === "POST" && route.name === "sessions") {
      res.status(201).json({
        session: await createSession(user.uid, route.workspaceId, req.body || {}),
      });
      return;
    }

    if (req.method === "POST" && route.name === "resizeSession") {
      res.json({
        session: await resizeSession(
            user.uid,
            route.workspaceId,
            route.sessionId,
            req.body || {},
        ),
      });
      return;
    }

    if (req.method === "POST" && route.name === "restartSession") {
      res.json({
        session: await restartSession(user.uid, route.workspaceId, route.sessionId),
      });
      return;
    }

    if (req.method === "POST" && route.name === "stopSession") {
      res.json({
        session: await stopSession(user.uid, route.workspaceId, route.sessionId),
      });
      return;
    }

    if (req.method === "GET" && route.name === "gitStatus") {
      res.json(await getGitStatusSummary(user.uid, route.workspaceId, route.sessionId));
      return;
    }

    if (req.method === "POST" && route.name === "gitPull") {
      res.json(await pullGit(user.uid, route.workspaceId, route.sessionId));
      return;
    }

    if (req.method === "POST" && route.name === "gitStage") {
      res.json(await stageGit(user.uid, route.workspaceId, route.sessionId, req.body || {}));
      return;
    }

    if (req.method === "POST" && route.name === "gitUnstage") {
      res.json(await unstageGit(user.uid, route.workspaceId, route.sessionId, req.body || {}));
      return;
    }

    if (req.method === "POST" && route.name === "gitCommit") {
      res.json(await commitGit(user.uid, route.workspaceId, route.sessionId, req.body || {}));
      return;
    }

    if (req.method === "POST" && route.name === "gitPush") {
      res.json(await pushGit(user.uid, route.workspaceId, route.sessionId));
      return;
    }

    if (req.method === "POST" && route.name === "gitOpenPr") {
      res.json(await openPullRequest(user.uid, route.workspaceId, route.sessionId, req.body || {}));
      return;
    }

    if (req.method === "GET" && route.name === "githubRepos") {
      res.json(await listConnectedRepos(user.uid));
      return;
    }

    res.status(404).json({error: "not_found"});
  } catch (error) {
    logger.error("api request failed", error);
    const status = error.status || 500;
    res.status(status).json({error: error.publicMessage || "internal_error"});
  }
});

exports.reapIdleSessions = onSchedule("every 5 minutes", async () => {
  const snap = await db.collectionGroup("sessions")
      .where("status", "==", "running")
      .get();
  const now = Date.now();
  const results = await Promise.allSettled(snap.docs.map(async (doc) => {
    const session = doc.data();
    if (!isIdleSession(session, now)) return false;
    logger.info("stopping idle session", {
      workspaceId: session.workspaceId,
      sessionId: doc.id,
      serviceId: session.serviceId,
    });
    await doc.ref.update({
      status: "stopping",
      stopReason: "idle_timeout",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await deleteSessionService(doc.ref, session, {reason: "idle_timeout"});
    return true;
  }));

  const stopped = results.filter((result) => result.status === "fulfilled" && result.value).length;
  const failed = results.filter((result) => result.status === "rejected");
  failed.forEach((result) => logger.error("idle session stop failed", result.reason));
  logger.info("idle session reap complete", {checked: snap.size, stopped, failed: failed.length});
});

function routeRequest(path) {
  const parts = path.replace(/^\/api\/?/, "/").split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "me") return {name: "me"};
  if (parts.length === 1 && parts[0] === "workspaces") return {name: "workspaces"};
  if (parts.length === 3 && parts[0] === "workspaces" && parts[2] === "files") {
    return {name: "workspaceFiles", workspaceId: parts[1]};
  }
  if (parts.length === 3 && parts[0] === "workspaces" && parts[2] === "file") {
    return {name: "workspaceFile", workspaceId: parts[1]};
  }
  if (parts.length === 3 && parts[0] === "workspaces" && parts[2] === "sessions") {
    return {name: "sessions", workspaceId: parts[1]};
  }
  if (
    parts.length === 5 &&
    parts[0] === "workspaces" &&
    parts[2] === "sessions" &&
    parts[4] === "resize"
  ) {
    return {name: "resizeSession", workspaceId: parts[1], sessionId: parts[3]};
  }
  if (
    parts.length === 5 &&
    parts[0] === "workspaces" &&
    parts[2] === "sessions" &&
    parts[4] === "restart"
  ) {
    return {name: "restartSession", workspaceId: parts[1], sessionId: parts[3]};
  }
  if (
    parts.length === 5 &&
    parts[0] === "workspaces" &&
    parts[2] === "sessions" &&
    parts[4] === "stop"
  ) {
    return {name: "stopSession", workspaceId: parts[1], sessionId: parts[3]};
  }
  if (
    parts.length === 5 &&
    parts[0] === "workspaces" &&
    parts[2] === "sessions" &&
    parts[4] === "git-status"
  ) {
    return {name: "gitStatus", workspaceId: parts[1], sessionId: parts[3]};
  }
  if (
    parts.length === 5 &&
    parts[0] === "workspaces" &&
    parts[2] === "sessions" &&
    parts[4] === "git-pull"
  ) {
    return {name: "gitPull", workspaceId: parts[1], sessionId: parts[3]};
  }
  if (
    parts.length === 5 &&
    parts[0] === "workspaces" &&
    parts[2] === "sessions" &&
    parts[4] === "git-stage"
  ) {
    return {name: "gitStage", workspaceId: parts[1], sessionId: parts[3]};
  }
  if (
    parts.length === 5 &&
    parts[0] === "workspaces" &&
    parts[2] === "sessions" &&
    parts[4] === "git-unstage"
  ) {
    return {name: "gitUnstage", workspaceId: parts[1], sessionId: parts[3]};
  }
  if (
    parts.length === 5 &&
    parts[0] === "workspaces" &&
    parts[2] === "sessions" &&
    parts[4] === "git-commit"
  ) {
    return {name: "gitCommit", workspaceId: parts[1], sessionId: parts[3]};
  }
  if (
    parts.length === 5 &&
    parts[0] === "workspaces" &&
    parts[2] === "sessions" &&
    parts[4] === "git-push"
  ) {
    return {name: "gitPush", workspaceId: parts[1], sessionId: parts[3]};
  }
  if (
    parts.length === 5 &&
    parts[0] === "workspaces" &&
    parts[2] === "sessions" &&
    parts[4] === "git-open-pr"
  ) {
    return {name: "gitOpenPr", workspaceId: parts[1], sessionId: parts[3]};
  }
  if (parts.length === 2 && parts[0] === "github" && parts[1] === "repos") {
    return {name: "githubRepos"};
  }
  return {name: "unknown"};
}

async function requireUser(req) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) {
    throw httpError(401, "missing_auth_token");
  }
  let token;
  try {
    token = await admin.auth().verifyIdToken(match[1]);
  } catch (error) {
    throw httpError(401, "invalid_auth_token", error);
  }
  return upsertUser(token);
}

async function upsertUser(token) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = db.collection("users").doc(token.uid);
  const profile = {
    uid: token.uid,
    email: cleanName(token.email || ""),
    displayName: cleanName(token.name || ""),
    photoURL: cleanName(token.picture || ""),
    providerIds: providerIdsFromToken(token),
    lastSignedInAt: now,
    updatedAt: now,
  };

  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (snap.exists) {
      transaction.update(ref, profile);
      return;
    }
    transaction.set(ref, {
      ...profile,
      createdAt: now,
    });
  });

  return toClientDoc(await ref.get());
}

async function listWorkspaces(uid) {
  const snap = await db.collection("workspaces")
      .where("ownerUid", "==", uid)
      .get();
  return snap.docs.map(toClientDoc).sort(sortByUpdatedAtDesc);
}

async function createWorkspace(uid, payload) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const name = cleanName(payload.name || "Default workspace");
  const bucket = cleanName(payload.bucket || DEFAULT_BUCKET);
  const source = await normalizeWorkspaceSourcePayload(uid, payload);
  const doc = {
    ownerUid: uid,
    userPath: userPath(uid),
    name,
    bucket,
    source: source.type === "blank" ? {
      type: "blank",
      status: "ready",
      statusMessage: null,
      resolvedBranch: null,
      resolvedCommit: null,
    } : {
      ...source,
      status: "pending",
      statusMessage: null,
      resolvedBranch: null,
      resolvedCommit: null,
    },
    syncPolicy: normalizeWorkspaceSyncPolicy(source),
    storagePrefix: `workspaces/${uid}/${slugify(name)}`,
    createdAt: now,
    updatedAt: now,
  };
  const ref = await db.collection("workspaces").add(doc);
  const snap = await ref.get();
  return toClientDoc(snap);
}

async function normalizeWorkspaceSourcePayload(uid, payload) {
  const source = payload && Object.prototype.hasOwnProperty.call(payload, "source") ? payload.source : undefined;
  if (source === undefined || source === null || source === "") {
    return {type: "blank"};
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
  if (type !== "github") {
    throw httpError(400, "unsupported_workspace_source_type");
  }

  const requestedBranch = cleanName(source.requestedBranch || source.branch || "");
  const requestedCommit = cleanName(source.requestedCommit || source.commit || "");
  if (requestedCommit && !/^[0-9a-f]{7,40}$/i.test(requestedCommit)) {
    throw httpError(400, "invalid_workspace_source_commit");
  }

  if (isConnectedGithubSourcePayload(source)) {
    return normalizeConnectedGithubSourcePayload(uid, source, {
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

function isConnectedGithubSourcePayload(source) {
  const mode = cleanName(source && source.mode).toLowerCase();
  if (mode === "connected") {
    return true;
  }
  return Boolean(cleanGithubNumericId(source && source.installationId) || cleanGithubNumericId(source && source.repoId));
}

async function normalizeConnectedGithubSourcePayload(uid, source, options = {}) {
  if (!isGithubAppConfigured()) {
    throw httpError(503, "github_app_not_configured");
  }

  const installationId = normalizeGithubInstallationId(source.installationId);
  const expectedRepoId = cleanGithubNumericId(source.repoId);
  const expectedOwner = cleanGithubValue(source.owner).toLowerCase();
  const expectedRepo = cleanGithubValue(source.repo).toLowerCase();
  const requestedRepoUrl = cleanGithubValue(source.repoUrl || source.url);
  const installation = await requireGithubInstallationForUser(uid, installationId);
  const tokenResponse = await createGithubInstallationToken(installationId);
  const repos = await listGithubInstallationRepositories(installationId, tokenResponse.token);
  const matchedRepo = repos.find((repo) => {
    const liveRepoId = cleanGithubNumericId(repo && repo.id);
    const liveOwner = cleanGithubValue(repo && repo.owner && repo.owner.login).toLowerCase();
    const liveName = cleanGithubValue(repo && repo.name).toLowerCase();
    const liveCloneUrl = cleanGithubValue(repo && repo.clone_url);
    if (expectedRepoId && liveRepoId) {
      return expectedRepoId === liveRepoId;
    }
    if (expectedOwner && expectedRepo) {
      return expectedOwner === liveOwner && expectedRepo === liveName;
    }
    return Boolean(requestedRepoUrl && liveCloneUrl && requestedRepoUrl === liveCloneUrl);
  });

  if (!matchedRepo) {
    throw httpError(403, "github_connected_repo_forbidden");
  }

  const owner = cleanGithubValue(matchedRepo.owner && matchedRepo.owner.login);
  const repo = cleanGithubValue(matchedRepo.name);
  const cloneUrl = cleanGithubValue(matchedRepo.clone_url);
  const repoId = cleanGithubNumericId(matchedRepo.id);
  if (!owner || !repo || !cloneUrl || !repoId) {
    throw httpError(502, "github_connected_repo_invalid");
  }

  return {
    type: "github",
    mode: "connected",
    repoUrl: cloneUrl,
    owner,
    repo,
    requestedBranch: options.requestedBranch || cleanGithubValue(matchedRepo.default_branch) || null,
    requestedCommit: options.requestedCommit || null,
    visibility: matchedRepo.private ? "private" : "public",
    connection: {
      installationId,
      repoId,
      ownerUid: uid,
    },
  };
}

async function requireGithubInstallationForUser(uid, installationId) {
  const [userSnap, installationDoc] = await Promise.all([
    githubUserDoc(uid).get(),
    githubInstallationCollection(uid).doc(installationId).get(),
  ]);
  if (!installationDoc.exists) {
    throw httpError(403, "github_installation_forbidden");
  }

  const userData = userSnap.exists ? userSnap.data() || {} : {};
  const allowedInstallationIds = new Set(normalizeGithubInstallationIds(userData.installationIds));
  const installation = normalizeGithubInstallationRecord(uid, installationDoc.id, installationDoc.data(), allowedInstallationIds);
  if (!installation) {
    throw httpError(403, "github_installation_forbidden");
  }
  return installation;
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
      ".mapahce-internal/",
    ],
  };
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

async function listSessions(uid, workspaceId) {
  await requireWorkspace(uid, workspaceId);
  const snap = await sessionCollection(workspaceId)
      .orderBy("updatedAt", "desc")
      .get();
  return snap.docs.map(toClientDoc);
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
  if (size > 1024 * 1024) throw httpError(413, "file_too_large");

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
  if (Buffer.byteLength(content, "utf8") > 1024 * 1024) {
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

async function createSession(uid, workspaceId, payload) {
  const workspace = await requireWorkspace(uid, workspaceId);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const sessionRef = sessionCollection(workspaceId).doc();
  const region = cleanName(payload.region || DEFAULT_REGION);
  const resources = normalizeResources(payload);
  const idleTimeoutMinutes = positiveNumber(
      payload.idleTimeoutMinutes,
      DEFAULT_IDLE_TIMEOUT_MINUTES,
  );
  const serviceId = `session-${sessionRef.id.toLowerCase()}`;
  const session = {
    ownerUid: uid,
    userPath: userPath(uid),
    workspaceId,
    runnerSessionId: sessionRef.id,
    workspaceStoragePrefix: workspace.storagePrefix,
    terminalHistoryPath: `workspaces/${workspaceId}/sessions/${sessionRef.id}/terminalHistory`,
    name: cleanName(payload.name || "Terminal session"),
    status: DEFAULT_IMAGE ? "provisioning" : "needs_image",
    region,
    image: cleanName(payload.image || DEFAULT_IMAGE),
    serviceId,
    serviceName: cloudRunServiceName(region, serviceId),
    serviceUrl: null,
    workspaceStorageBucket: workspace.bucket || DEFAULT_BUCKET,
    ...sessionSourceMetadata(workspace),
    ...sessionSyncPolicyMetadata(workspace),
    resources,
    activeSocketCount: 0,
    idleTimeoutMinutes,
    lastActivityAt: now,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    autoStoppedAt: null,
    stopReason: null,
    shutdownToken: crypto.randomBytes(24).toString("hex"),
    createdAt: now,
    updatedAt: now,
    restartedAt: null,
    lastError: DEFAULT_IMAGE ? null : "Set SESSION_RUNNER_IMAGE before provisioning Cloud Run sessions.",
  };

  if (isGithubWorkspace(workspace)) {
    await reserveGithubWorkspaceSession(workspaceId, sessionRef, session);
  } else {
    await sessionRef.set(session);
  }

  if (DEFAULT_IMAGE || payload.image) {
    await provisionSessionService(workspace, sessionRef, session);
  }

  return toClientDoc(await sessionRef.get());
}

async function reserveGithubWorkspaceSession(workspaceId, sessionRef, session) {
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(sessionCollection(workspaceId));
    const activeSession = snap.docs.find((doc) => isActiveGithubWorkspaceSession(doc.data()));
    if (activeSession) {
      throw httpError(409, "This GitHub workspace already has an active session. Stop it before creating another one.");
    }
    transaction.set(sessionRef, session);
  });
}

function isGithubWorkspace(workspace) {
  return workspace && workspace.source && workspace.source.type === "github";
}

function isActiveGithubWorkspaceSession(session) {
  return !isTerminalSessionStatus(session && session.status);
}

function isTerminalSessionStatus(status) {
  return ["stopped", "provision_failed", "needs_image"].includes(cleanName(status));
}

async function resizeSession(uid, workspaceId, sessionId, payload) {
  const {sessionRef, sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const resources = normalizeResources(payload);
  await sessionRef.update({
    resources,
    status: "resizing",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await patchSessionService(sessionRef, {...sessionSnap.data(), resources});
  return toClientDoc(await sessionRef.get());
}

async function restartSession(uid, workspaceId, sessionId) {
  const {sessionRef, sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  await sessionRef.update({
    status: "restarting",
    restartNonce: Date.now().toString(),
    restartedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await patchSessionService(sessionRef, sessionSnap.data(), {restart: true});
  return toClientDoc(await sessionRef.get());
}

async function stopSession(uid, workspaceId, sessionId) {
  const {sessionRef, sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  await sessionRef.update({
    status: "stopping",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await deleteSessionService(sessionRef, sessionSnap.data(), {reason: "manual"});
  return toClientDoc(await sessionRef.get());
}

async function getGitStatusSummary(uid, workspaceId, sessionId) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};

  if (!session.serviceUrl) {
    throw httpError(409, "session_not_running");
  }
  if (!session.shutdownToken) {
    throw httpError(503, "runner_git_status_unavailable");
  }

  return requestRunnerGitStatus(session);
}

async function pullGit(uid, workspaceId, sessionId) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};

  if (!session.serviceUrl) {
    throw httpError(409, "session_not_running");
  }
  if (!session.shutdownToken) {
    throw httpError(503, "runner_git_pull_unavailable");
  }

  return requestRunnerGitPull(session);
}

async function stageGit(uid, workspaceId, sessionId, payload) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "session_not_running");
  if (!session.shutdownToken) throw httpError(503, "runner_git_stage_unavailable");
  return requestRunnerGitStage(session, {paths: normalizeGitActionPayloadPaths(payload)});
}

async function unstageGit(uid, workspaceId, sessionId, payload) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "session_not_running");
  if (!session.shutdownToken) throw httpError(503, "runner_git_unstage_unavailable");
  return requestRunnerGitUnstage(session, {paths: normalizeGitActionPayloadPaths(payload)});
}

async function commitGit(uid, workspaceId, sessionId, payload) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "session_not_running");
  if (!session.shutdownToken) throw httpError(503, "runner_git_commit_unavailable");
  return requestRunnerGitCommit(session, {message: normalizeGitCommitMessage(payload)});
}

async function pushGit(uid, workspaceId, sessionId) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "session_not_running");
  if (!session.shutdownToken) throw httpError(503, "runner_git_push_unavailable");
  return requestRunnerGitPush(session);
}

async function openPullRequest(uid, workspaceId, sessionId, payload) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (cleanName(session.sourceType) !== "github") {
    throw httpError(400, "not_git_workspace");
  }
  if (cleanName(session.sourceMode) !== "connected") {
    throw httpError(400, "github_pr_requires_connected_repo");
  }
  if (!session.serviceUrl) throw httpError(409, "session_not_running");
  if (!session.shutdownToken) throw httpError(503, "runner_git_open_pr_unavailable");

  const installationId = cleanGithubNumericId(session.sourceInstallationId);
  const owner = cleanGithubValue(session.sourceRepoOwner);
  const repo = cleanGithubValue(session.sourceRepoName);
  if (!installationId || !owner || !repo) {
    throw httpError(503, "github_pr_auth_unavailable");
  }

  const tokenResponse = await createGithubInstallationToken(installationId);
  const repository = await getGithubRepository(owner, repo, tokenResponse.token);
  const baseBranch = cleanGithubValue(repository.default_branch);
  if (!baseBranch) {
    throw httpError(502, "github_default_branch_unavailable");
  }

  const prepared = await requestRunnerGitOpenPr(session, {
    baseBranch,
    workingBranchName: buildWorkingBranchName(payload && payload.branchDescription),
    pushToken: tokenResponse.token,
    pushUsername: "x-access-token",
  });

  const template = await getGithubPullRequestTemplate(owner, repo, baseBranch, tokenResponse.token);
  const title = normalizePullRequestTitle(
      (payload && payload.title) || prepared.pullRequest && prepared.pullRequest.defaultTitle,
  );
  if (!title) {
    throw httpError(400, "missing_pull_request_title");
  }

  const body = Object.prototype.hasOwnProperty.call(payload || {}, "body") ?
    normalizePullRequestBody(payload.body) :
    template.body;
  const pullRequest = await createGithubPullRequest({
    owner,
    repo,
    token: tokenResponse.token,
    title,
    body,
    head: cleanGithubValue(prepared.pullRequest && prepared.pullRequest.branch),
    base: baseBranch,
    draft: Boolean(payload && payload.draft),
  });

  return {
    ...prepared,
    action: "open_pr",
    pullRequest: {
      number: Number(pullRequest.number || 0) || null,
      url: cleanGithubValue(pullRequest.html_url),
      title: cleanGithubValue(pullRequest.title) || title,
      draft: Boolean(pullRequest.draft),
      head: cleanGithubValue(pullRequest.head && pullRequest.head.ref) || cleanGithubValue(prepared.pullRequest && prepared.pullRequest.branch),
      base: cleanGithubValue(pullRequest.base && pullRequest.base.ref) || baseBranch,
      bodySource: template.source,
    },
  };
}

async function listConnectedRepos(uid) {
  if (!isGithubAppConfigured()) {
    throw httpError(503, "github_app_not_configured");
  }

  const [userSnap, installationSnap] = await Promise.all([
    githubUserDoc(uid).get(),
    githubInstallationCollection(uid).get(),
  ]);
  const userData = userSnap.exists ? userSnap.data() || {} : {};
  const connectionStatus = cleanName(userData.connectionStatus).toLowerCase();
  if (connectionStatus === "disconnected") {
    return {repos: []};
  }

  const allowedInstallationIds = new Set(normalizeGithubInstallationIds(userData.installationIds));
  const installations = installationSnap.docs
      .map((doc) => normalizeGithubInstallationRecord(uid, doc.id, doc.data(), allowedInstallationIds))
      .filter(Boolean);

  const repos = [];
  for (const installation of installations) {
    let tokenResponse;
    try {
      tokenResponse = await createGithubInstallationToken(installation.installationId);
    } catch (error) {
      if (isGithubInstallationNotFoundError(error)) {
        logger.warn("github installation missing during repo listing", {
          installationId: installation.installationId,
          uid,
        });
        continue;
      }
      throw error;
    }

    const storedRepos = await listStoredGithubInstallationRepositories(uid, installation.installationId);
    const liveRepos = await listGithubInstallationRepositories(
        installation.installationId,
        tokenResponse.token,
    );
    const repoMap = new Map();

    storedRepos.forEach((repo) => {
      repoMap.set(githubRepoMapKey(repo), repo);
    });

    liveRepos.forEach((repo) => {
      const normalizedRepo = normalizeGithubConnectedRepo(
          installation,
          repo,
          repoMap.get(githubRepoMapKey(repo)) || null,
          tokenResponse.repositorySelection,
      );
      if (normalizedRepo) {
        repos.push(normalizedRepo);
      }
    });
  }

  repos.sort((left, right) => {
    const leftKey = `${left.fullName || ""} ${left.installationId || ""}`.trim();
    const rightKey = `${right.fullName || ""} ${right.installationId || ""}`.trim();
    return leftKey.localeCompare(rightKey);
  });

  return {repos};
}

async function createGithubInstallationToken(installationId) {
  if (!isGithubAppConfigured()) {
    throw httpError(503, "github_app_not_configured");
  }

  const normalizedInstallationId = normalizeGithubInstallationId(installationId);
  const appJwt = createGithubAppJwt();
  const response = await requestGithubInstallationToken(normalizedInstallationId, appJwt);

  return {
    installationId: normalizedInstallationId,
    token: cleanGithubToken(response.token),
    expiresAt: cleanGithubTimestamp(response.expires_at),
    permissions: normalizeGithubTokenPermissions(response.permissions),
    repositorySelection: cleanGithubValue(response.repository_selection),
  };
}

function isGithubAppConfigured() {
  return Boolean(normalizeGithubAppId(process.env.GITHUB_APP_ID) && normalizeGithubPrivateKey());
}

function normalizeGithubInstallationId(value) {
  const installationId = String(value || "").trim();
  if (!/^\d+$/.test(installationId)) {
    throw httpError(400, "invalid_github_installation_id");
  }
  return installationId;
}

function normalizeGithubAppId(value) {
  return String(value || "").trim();
}

function normalizeGithubPrivateKey() {
  const key = String(process.env.GITHUB_APP_PRIVATE_KEY || "").trim();
  return key ? key.replace(/\\n/g, "\n") : "";
}

function createGithubAppJwt() {
  const appId = normalizeGithubAppId(process.env.GITHUB_APP_ID);
  const privateKey = normalizeGithubPrivateKey();
  if (!appId || !privateKey) {
    throw httpError(503, "github_app_not_configured");
  }

  const issuedAt = Math.floor(Date.now() / 1000) - 60;
  const expiresAt = issuedAt + (9 * 60);
  const header = {alg: "RS256", typ: "JWT"};
  const payload = {
    iat: issuedAt,
    exp: expiresAt,
    iss: appId,
  };
  const encodedHeader = encodeJwtSegment(header);
  const encodedPayload = encodeJwtSegment(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  try {
    const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey)
        .toString("base64url");
    return `${signingInput}.${signature}`;
  } catch (error) {
    throw httpError(502, "github_app_jwt_failed", error);
  }
}

function encodeJwtSegment(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function requestGithubInstallationToken(installationId, appJwt) {
  let response;
  try {
    response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${appJwt}`,
        "user-agent": "mapahce-functions",
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch (error) {
    throw httpError(502, "github_installation_token_failed", error);
  }

  if (response.status === 404) {
    throw httpError(404, "github_installation_not_found");
  }

  if (!response.ok) {
    const errorBody = await safeReadGithubErrorBody(response);
    logger.error("github installation token request failed", {
      installationId,
      status: response.status,
      body: errorBody,
    });
    throw httpError(502, "github_installation_token_failed");
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw httpError(502, "github_installation_token_failed", error);
  }

  if (!data || typeof data.token !== "string" || !data.token.trim()) {
    throw httpError(502, "github_installation_token_failed");
  }

  return data;
}

async function getGithubRepository(owner, repo, token) {
  return requestGithubJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token, {
    failureError: "github_repository_lookup_failed",
  });
}

async function getGithubPullRequestTemplate(owner, repo, baseBranch, token) {
  const directPaths = [
    ".github/pull_request_template.md",
    ".github/pull_request_template.txt",
    "docs/pull_request_template.md",
    "docs/pull_request_template.txt",
    "pull_request_template.md",
    "pull_request_template.txt",
  ];
  for (const templatePath of directPaths) {
    const content = await getGithubRepositoryFile(owner, repo, templatePath, baseBranch, token);
    if (content) {
      return {body: content, source: `repository_template:${templatePath}`};
    }
  }

  const templateDirs = [
    ".github/PULL_REQUEST_TEMPLATE",
    "docs/PULL_REQUEST_TEMPLATE",
    "PULL_REQUEST_TEMPLATE",
  ];
  for (const directoryPath of templateDirs) {
    const entries = await listGithubRepositoryDirectory(owner, repo, directoryPath, baseBranch, token);
    const templateEntry = (entries || [])
        .filter((entry) => entry && entry.type === "file" && /\.(md|txt)$/i.test(entry.name || ""))
        .sort((left, right) => cleanGithubValue(left.path).localeCompare(cleanGithubValue(right.path)))[0];
    if (!templateEntry || !templateEntry.path) {
      continue;
    }
    const content = await getGithubRepositoryFile(owner, repo, templateEntry.path, baseBranch, token);
    if (content) {
      return {body: content, source: `repository_template:${cleanGithubValue(templateEntry.path)}`};
    }
  }

  return {
    body: defaultPullRequestBody(),
    source: "fallback_template",
  };
}

async function getGithubRepositoryFile(owner, repo, filePath, ref, token) {
  let data;
  try {
    data = await requestGithubJson(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeGithubContentPath(filePath)}?ref=${encodeURIComponent(ref)}`,
        token,
        {failureError: "github_repository_file_lookup_failed"},
    );
  } catch (error) {
    if (error && error.status === 404) {
      return "";
    }
    throw error;
  }

  if (!data || Array.isArray(data) || cleanGithubValue(data.type) !== "file") {
    return "";
  }
  if (cleanGithubValue(data.encoding) !== "base64") {
    return "";
  }

  try {
    return Buffer.from(String(data.content || "").replace(/\n/g, ""), "base64").toString("utf8");
  } catch (error) {
    throw httpError(502, "github_repository_file_decode_failed", error);
  }
}

async function listGithubRepositoryDirectory(owner, repo, directoryPath, ref, token) {
  try {
    const data = await requestGithubJson(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeGithubContentPath(directoryPath)}?ref=${encodeURIComponent(ref)}`,
        token,
        {failureError: "github_repository_directory_lookup_failed"},
    );
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error && error.status === 404) {
      return [];
    }
    throw error;
  }
}

async function createGithubPullRequest({owner, repo, token, title, body, head, base, draft}) {
  return requestGithubJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, token, {
    method: "POST",
    body: {
      title,
      head,
      base,
      body,
      draft: Boolean(draft),
    },
    failureError: "github_pull_request_create_failed",
  });
}

async function requestGithubJson(url, token, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "mapahce-functions",
        "x-github-api-version": "2022-11-28",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    throw httpError(502, options.failureError || "github_request_failed", error);
  }

  const data = await response.json().catch(() => ({}));
  if (response.status === 404) {
    throw httpError(404, cleanGithubApiMessage(data) || options.failureError || "github_request_failed");
  }
  if (!response.ok) {
    const status = response.status === 422 || response.status === 409 ? 400 : 502;
    throw httpError(status, cleanGithubApiMessage(data) || options.failureError || "github_request_failed");
  }
  return data;
}

function cleanGithubApiMessage(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  const message = cleanGithubValue(value.message || "");
  const detail = Array.isArray(value.errors) ? value.errors.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return cleanGithubValue(entry);
    }
    return cleanGithubValue(entry.message || entry.code || entry.field || entry.resource);
  }).filter(Boolean)[0] : "";
  return [message, detail].filter(Boolean).join(": ");
}

function encodeGithubContentPath(value) {
  return String(value || "").split("/").filter(Boolean).map((part) => encodeURIComponent(part)).join("/");
}

function defaultPullRequestBody() {
  return [
    "## Summary",
    "- ",
    "",
    "## Testing",
    "- Not run (fill in)",
  ].join("\n");
}

async function safeReadGithubErrorBody(response) {
  try {
    const text = await response.text();
    return cleanGithubErrorBody(text);
  } catch (error) {
    return "";
  }
}

function cleanGithubErrorBody(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function cleanGithubToken(value) {
  const token = String(value || "").trim();
  if (!token) {
    throw httpError(502, "github_installation_token_failed");
  }
  return token;
}

function cleanGithubTimestamp(value) {
  const timestamp = String(value || "").trim();
  return timestamp || "";
}

function normalizeGithubTokenPermissions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.entries(value).reduce((result, [key, permission]) => {
    const normalizedKey = cleanGithubValue(key);
    const normalizedPermission = cleanGithubValue(permission);
    if (normalizedKey && normalizedPermission) {
      result[normalizedKey] = normalizedPermission;
    }
    return result;
  }, {});
}

function cleanGithubValue(value) {
  return String(value || "").trim().slice(0, 256);
}

function cleanGithubNumericId(value) {
  const normalized = String(value == null ? "" : value).trim();
  return /^\d+$/.test(normalized) ? normalized : "";
}

function githubUserDoc(uid) {
  return db.collection("githubUsers").doc(uid);
}

function githubInstallationCollection(uid) {
  return githubUserDoc(uid).collection("installations");
}

function githubInstallationRepoCollection(uid, installationId) {
  return githubInstallationCollection(uid).doc(installationId).collection("repositories");
}

function normalizeGithubInstallationIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
      .map(cleanGithubNumericId)
      .filter(Boolean);
}

function normalizeGithubInstallationRecord(uid, installationId, value, allowedInstallationIds) {
  const normalizedInstallationId = cleanGithubNumericId(installationId || value && value.installationId);
  if (!normalizedInstallationId) {
    return null;
  }
  if (allowedInstallationIds.size && !allowedInstallationIds.has(normalizedInstallationId)) {
    return null;
  }

  const ownerUid = cleanGithubValue(value && value.ownerUid);
  if (ownerUid && ownerUid !== uid) {
    return null;
  }

  const status = cleanName(value && value.installationStatus).toLowerCase();
  if (status && status !== "active") {
    return null;
  }

  return {
    installationId: normalizedInstallationId,
    githubAccountLogin: cleanGithubValue(value && value.githubAccountLogin),
    repositorySelection: cleanGithubValue(value && value.repositorySelection),
  };
}

async function listStoredGithubInstallationRepositories(uid, installationId) {
  const snap = await githubInstallationRepoCollection(uid, installationId).get();
  return snap.docs
      .map((doc) => normalizeStoredGithubRepositoryRecord(uid, installationId, doc.id, doc.data()))
      .filter(Boolean);
}

function normalizeStoredGithubRepositoryRecord(uid, installationId, docId, value) {
  const ownerUid = cleanGithubValue(value && value.ownerUid);
  if (ownerUid && ownerUid !== uid) {
    return null;
  }
  if (value && value.accessible === false) {
    return null;
  }

  const normalizedInstallationId = cleanGithubNumericId(value && value.installationId) || installationId;
  if (normalizedInstallationId !== installationId) {
    return null;
  }

  const repoId = cleanGithubNumericId(docId || value && value.repoId);
  const owner = cleanGithubValue(value && (value.ownerLogin || value.owner));
  const name = cleanGithubValue(value && value.name);
  const fullName = cleanGithubValue(value && (value.fullName || (owner && name ? `${owner}/${name}` : "")));
  if (!repoId && !fullName) {
    return null;
  }

  return {
    repoId,
    owner,
    name,
    fullName,
    defaultBranch: cleanGithubValue(value && value.defaultBranch),
    private: Boolean(value && value.private),
    cloneUrl: cleanGithubValue(value && value.cloneUrl),
    htmlUrl: cleanGithubValue(value && value.htmlUrl),
  };
}

async function listGithubInstallationRepositories(installationId, token) {
  const repositories = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = new URL("https://api.github.com/installation/repositories");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    let response;
    try {
      response = await fetch(url, {
        headers: {
          "accept": "application/vnd.github+json",
          "authorization": `Bearer ${token}`,
          "user-agent": "mapahce-functions",
          "x-github-api-version": "2022-11-28",
        },
      });
    } catch (error) {
      throw httpError(502, "github_connected_repos_failed", error);
    }

    if (response.status === 404) {
      throw httpError(404, "github_installation_not_found");
    }

    if (!response.ok) {
      const errorBody = await safeReadGithubErrorBody(response);
      logger.error("github installation repository list failed", {
        installationId,
        status: response.status,
        body: errorBody,
      });
      throw httpError(502, "github_connected_repos_failed");
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw httpError(502, "github_connected_repos_failed", error);
    }

    const pageRepos = Array.isArray(data && data.repositories) ? data.repositories : null;
    if (!pageRepos) {
      throw httpError(502, "github_connected_repos_failed");
    }

    repositories.push(...pageRepos);
    if (pageRepos.length < 100) {
      break;
    }
  }

  return repositories;
}

function githubRepoMapKey(value) {
  const repoId = cleanGithubNumericId(value && (value.id || value.repoId));
  if (repoId) {
    return `id:${repoId}`;
  }

  const owner = cleanGithubValue(value && (value.owner && value.owner.login || value.ownerLogin || value.owner));
  const name = cleanGithubValue(value && (value.name || value.repo));
  if (owner && name) {
    return `name:${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  const fullName = cleanGithubValue(value && (value.full_name || value.fullName));
  return fullName ? `name:${fullName.toLowerCase()}` : "";
}

function normalizeGithubConnectedRepo(installation, liveRepo, storedRepo, repositorySelection) {
  const owner = cleanGithubValue(
      liveRepo && liveRepo.owner && liveRepo.owner.login ||
      storedRepo && storedRepo.owner ||
      installation && installation.githubAccountLogin,
  );
  const name = cleanGithubValue(liveRepo && liveRepo.name || storedRepo && storedRepo.name);
  const fullName = cleanGithubValue(
      liveRepo && liveRepo.full_name ||
      storedRepo && storedRepo.fullName ||
      (owner && name ? `${owner}/${name}` : ""),
  );
  if (!owner || !name || !fullName) {
    return null;
  }

  const cloneUrl = cleanGithubValue(
      liveRepo && liveRepo.clone_url ||
      storedRepo && storedRepo.cloneUrl ||
      `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}.git`,
  );
  const repoUrl = cleanGithubValue(
      liveRepo && liveRepo.html_url ||
      storedRepo && storedRepo.htmlUrl ||
      `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  );
  const isPrivate = Boolean(liveRepo && liveRepo.private != null ? liveRepo.private : storedRepo && storedRepo.private);

  return {
    repoId: cleanGithubNumericId(liveRepo && liveRepo.id || storedRepo && storedRepo.repoId),
    installationId: installation.installationId,
    owner,
    name,
    fullName,
    defaultBranch: cleanGithubValue(
        liveRepo && liveRepo.default_branch ||
        storedRepo && storedRepo.defaultBranch ||
        "main",
    ),
    private: isPrivate,
    visibility: cleanGithubValue(liveRepo && liveRepo.visibility || (isPrivate ? "private" : "public")),
    cloneUrl,
    repoUrl,
    repositorySelection: cleanGithubValue(
        repositorySelection || installation.repositorySelection,
    ),
  };
}

function isGithubInstallationNotFoundError(error) {
  return Boolean(error && error.status === 404 && error.publicMessage === "github_installation_not_found");
}

async function requireWorkspace(uid, workspaceId) {
  const snap = await db.collection("workspaces").doc(workspaceId).get();
  if (!snap.exists) throw httpError(404, "workspace_not_found");
  const data = snap.data();
  if (data.ownerUid !== uid) throw httpError(403, "workspace_forbidden");
  return {id: snap.id, ...data};
}

async function requireSession(uid, workspaceId, sessionId) {
  await requireWorkspace(uid, workspaceId);
  const sessionRef = sessionCollection(workspaceId).doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) throw httpError(404, "session_not_found");
  const data = sessionSnap.data();
  if (data.ownerUid && data.ownerUid !== uid) throw httpError(403, "session_forbidden");
  return {sessionRef, sessionSnap};
}

function sessionCollection(workspaceId) {
  return db.collection("workspaces").doc(workspaceId).collection("sessions");
}

function providerIdsFromToken(token) {
  const firebase = token.firebase || {};
  const ids = Object.keys(firebase.identities || {}).filter((id) => id !== "email");
  if (firebase.sign_in_provider && !ids.includes(firebase.sign_in_provider)) {
    ids.unshift(firebase.sign_in_provider);
  }
  return ids;
}

function userPath(uid) {
  return `users/${uid}`;
}

async function provisionSessionService(workspace, sessionRef, session) {
  try {
    const client = await auth.getClient();
    const parent = `projects/${await getProjectId()}/locations/${session.region}`;
    const url = `https://run.googleapis.com/v2/${parent}/services?serviceId=${session.serviceId}`;
    const body = await buildCloudRunService(workspace, session);
    const response = await client.request({url, method: "POST", data: body});
    await waitForOperation(client, response.data);
    await setPublicInvoker(client, `${parent}/services/${session.serviceId}`);
    const service = await getCloudRunService(
        client,
        `${parent}/services/${session.serviceId}`,
    );
    await sessionRef.update({
      status: "running",
      serviceUrl: service.uri || null,
      lastError: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    await sessionRef.update({
      status: "provision_failed",
      lastError: publicGoogleError(error),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

async function patchSessionService(sessionRef, session, options = {}) {
  if (!session.serviceName) {
    await sessionRef.update({
      status: "needs_service",
      lastError: "This session has no Cloud Run serviceName yet.",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return;
  }

  try {
    const client = await auth.getClient();
    const url = `https://run.googleapis.com/v2/${session.serviceName}`;
    const body = {
      template: {
        containers: [{
          image: session.image,
          resources: {limits: resourceLimits(session.resources)},
          env: options.restart ? await sessionRunnerEnv(session, {
            restartNonce: Date.now().toString(),
          }) : undefined,
        }],
      },
    };
    const updateMask = options.restart ?
      "template.containers" :
      "template.containers.resources.limits";
    const response = await client.request({
      url: `${url}?updateMask=${encodeURIComponent(updateMask)}`,
      method: "PATCH",
      data: body,
    });
    await waitForOperation(client, response.data);
    const service = await getCloudRunService(client, session.serviceName);
    await sessionRef.update({
      status: "running",
      serviceUrl: service.uri || session.serviceUrl || null,
      lastError: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    await sessionRef.update({
      status: "update_failed",
      lastError: publicGoogleError(error),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

async function deleteSessionService(sessionRef, session, options = {}) {
  if (!session.serviceName) {
    await markSessionStopped(sessionRef, options.reason);
    return;
  }

  try {
    await requestRunnerShutdown(session);
    const client = await auth.getClient();
    const url = `https://run.googleapis.com/v2/${session.serviceName}`;
    const response = await client.request({url, method: "DELETE"});
    await waitForOperation(client, response.data);
    await markSessionStopped(sessionRef, options.reason);
  } catch (error) {
    if (isGoogleNotFound(error)) {
      await markSessionStopped(sessionRef, options.reason);
      return;
    }

    await sessionRef.update({
      status: "stop_failed",
      lastError: publicGoogleError(error),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

async function markSessionStopped(sessionRef, reason) {
  const stopped = {
    status: "stopped",
    activeSocketCount: 0,
    serviceUrl: null,
    stoppedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastError: null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (reason) stopped.stopReason = reason;
  if (reason === "idle_timeout") {
    stopped.autoStoppedAt = admin.firestore.FieldValue.serverTimestamp();
  }
  await sessionRef.update(stopped);
}

async function buildCloudRunService(workspace, session) {
  return {
    template: {
      scaling: {
        minInstanceCount: 0,
        maxInstanceCount: 1,
      },
      containers: [{
        image: session.image,
        ports: [{containerPort: 8080}],
        resources: {limits: resourceLimits(session.resources)},
        env: [
          ...await sessionRunnerEnv({
            ...session,
            workspaceId: workspace.id,
            workspaceStorageBucket: workspace.bucket || DEFAULT_BUCKET,
            workspaceStoragePrefix: workspace.storagePrefix,
          }),
        ],
      }],
    },
  };
}

async function sessionRunnerEnv(session, options = {}) {
  const env = [
    {name: "FIREBASE_PROJECT_ID", value: process.env.GCLOUD_PROJECT || ""},
    {name: "WORKSPACE_ID", value: session.workspaceId || ""},
    {name: "SESSION_ID", value: session.runnerSessionId || ""},
    {name: "STORAGE_BUCKET", value: session.workspaceStorageBucket || DEFAULT_BUCKET || ""},
    {name: "STORAGE_PREFIX", value: session.workspaceStoragePrefix || ""},
    {name: "SESSION_SHUTDOWN_TOKEN", value: session.shutdownToken || ""},
    {name: "WORKSPACE_SOURCE_TYPE", value: cleanName(session.sourceType || "blank") || "blank"},
    {name: "WORKSPACE_SYNC_POLICY_MODE", value: cleanName(session.syncPolicyMode || "blank") || "blank"},
    {name: "WORKSPACE_SYNC_POLICY_EXCLUDE", value: stringifySyncPolicyExclude(session.syncPolicyExclude)},
    options.restartNonce ? {name: "RESTART_NONCE", value: options.restartNonce} : null,
  ];

  if (cleanName(session.sourceType) === "github") {
    env.push(
        {name: "GITHUB_REPO_URL", value: cleanName(session.sourceRepoUrl || "")},
        {name: "GITHUB_REPO_OWNER", value: cleanName(session.sourceRepoOwner || "")},
        {name: "GITHUB_REPO_NAME", value: cleanName(session.sourceRepoName || "")},
        {name: "GITHUB_REQUESTED_BRANCH", value: cleanName(session.sourceRequestedBranch || "")},
        {name: "GITHUB_REQUESTED_COMMIT", value: cleanName(session.sourceRequestedCommit || "")},
        {name: "GITHUB_RESOLVED_BRANCH", value: cleanName(session.sourceResolvedBranch || "")},
        {name: "GITHUB_RESOLVED_COMMIT", value: cleanName(session.sourceResolvedCommit || "")},
        {
          name: "GITHUB_CHECKOUT_REF",
          value: cleanName(
              session.sourceResolvedCommit ||
              session.sourceRequestedCommit ||
              session.sourceResolvedBranch ||
              session.sourceRequestedBranch ||
              "",
          ),
        },
    );

    env.push(...await buildGithubCloneEnv(session));
  }

  return env.filter(Boolean);
}

async function buildGithubCloneEnv(session) {
  if (cleanName(session.sourceType) !== "github") {
    return [];
  }

  if (cleanName(session.sourceMode) !== "connected") {
    return [];
  }

  if (cleanName(session.sourceVisibility) !== "private") {
    return [];
  }

  const installationId = cleanGithubNumericId(session.sourceInstallationId);
  if (!installationId) {
    throw httpError(503, "github_clone_auth_unavailable");
  }

  const tokenResponse = await createGithubInstallationToken(installationId);
  return [
    {name: "GITHUB_CLONE_USERNAME", value: "x-access-token"},
    {name: "GITHUB_CLONE_TOKEN", value: tokenResponse.token},
  ];
}

function sessionSourceMetadata(workspace) {
  const source = workspace && workspace.source ? workspace.source : {type: "blank"};
  if (source.type !== "github") {
    return {sourceType: "blank"};
  }

  return {
    sourceType: "github",
    sourceMode: cleanName(source.mode || "public"),
    sourceVisibility: cleanName(source.visibility || "public"),
    sourceRepoUrl: cleanName(source.repoUrl || ""),
    sourceRepoOwner: cleanName(source.owner || ""),
    sourceRepoName: cleanName(source.repo || ""),
    sourceRequestedBranch: cleanName(source.requestedBranch || ""),
    sourceRequestedCommit: cleanName(source.requestedCommit || ""),
    sourceResolvedBranch: cleanName(source.resolvedBranch || ""),
    sourceResolvedCommit: cleanName(source.resolvedCommit || ""),
    sourceInstallationId: cleanGithubNumericId(source.connection && source.connection.installationId),
    sourceRepoId: cleanGithubNumericId(source.connection && source.connection.repoId),
  };
}

function sessionSyncPolicyMetadata(workspace) {
  const syncPolicy = workspace && workspace.syncPolicy ? workspace.syncPolicy : {mode: "blank", exclude: []};
  return {
    syncPolicyMode: cleanName(syncPolicy.mode || "blank") || "blank",
    syncPolicyExclude: Array.isArray(syncPolicy.exclude) ?
      syncPolicy.exclude.map((value) => cleanName(value)).filter(Boolean) :
      [],
  };
}

function stringifySyncPolicyExclude(value) {
  try {
    return JSON.stringify(Array.isArray(value) ? value : []);
  } catch (error) {
    return "[]";
  }
}

async function requestRunnerShutdown(session) {
  if (!session.serviceUrl || !session.shutdownToken) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_RUNNER_SHUTDOWN_TIMEOUT_MS);
  try {
    const response = await fetch(`${session.serviceUrl.replace(/\/+$/, "")}/shutdown`, {
      method: "POST",
      headers: {"x-shutdown-token": session.shutdownToken},
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn("runner shutdown request failed", {
        serviceId: session.serviceId,
        status: response.status,
      });
    }
  } catch (error) {
    logger.warn("runner shutdown request failed", {
      serviceId: session.serviceId,
      error: cleanName(error.message || error),
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestRunnerGitStatus(session) {
  return requestRunnerJson(session, "/git/status", {
    unavailableError: "runner_git_status_unavailable",
  });
}

async function requestRunnerGitPull(session) {
  return requestRunnerJson(session, "/git/pull", {
    method: "POST",
    unavailableError: "runner_git_pull_unavailable",
  });
}

async function requestRunnerGitStage(session, body) {
  return requestRunnerJson(session, "/git/stage", {
    method: "POST",
    body,
    unavailableError: "runner_git_stage_unavailable",
  });
}

async function requestRunnerGitUnstage(session, body) {
  return requestRunnerJson(session, "/git/unstage", {
    method: "POST",
    body,
    unavailableError: "runner_git_unstage_unavailable",
  });
}

async function requestRunnerGitCommit(session, body) {
  return requestRunnerJson(session, "/git/commit", {
    method: "POST",
    body,
    unavailableError: "runner_git_commit_unavailable",
  });
}

async function requestRunnerGitPush(session) {
  return requestRunnerJson(session, "/git/push", {
    method: "POST",
    unavailableError: "runner_git_push_unavailable",
  });
}

async function requestRunnerGitOpenPr(session, body) {
  return requestRunnerJson(session, "/git/open-pr", {
    method: "POST",
    body,
    unavailableError: "runner_git_open_pr_unavailable",
  });
}

async function requestRunnerJson(session, routePath, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  try {
    const response = await fetch(`${session.serviceUrl.replace(/\/+$/, "")}${routePath}`, {
      method: options.method || "GET",
      headers: {
        "x-shutdown-token": session.shutdownToken,
        "Content-Type": "application/json",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw httpError(
          response.status === 404 ? 503 : response.status,
          cleanName(data.error || options.failureError || "runner_request_failed") ||
            options.failureError ||
            "runner_request_failed",
      );
    }
    return data;
  } catch (error) {
    if (error && error.status) throw error;
    throw httpError(503, options.unavailableError || "runner_request_unavailable", error);
  } finally {
    clearTimeout(timeout);
  }
}

async function setPublicInvoker(client, serviceName) {
  const url = `https://run.googleapis.com/v2/${serviceName}:setIamPolicy`;
  await client.request({
    url,
    method: "POST",
    data: {
      policy: {
        bindings: [{
          role: "roles/run.invoker",
          members: ["allUsers"],
        }],
      },
    },
  });
}

async function waitForOperation(client, operation) {
  if (!operation || !operation.name) return;
  const url = `https://run.googleapis.com/v2/${operation.name}`;
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await client.request({url, method: "GET"});
    if (response.data && response.data.done) {
      if (response.data.error) {
        throw new Error(JSON.stringify(response.data.error));
      }
      return response.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Cloud Run operation timed out.");
}

async function getCloudRunService(client, serviceName) {
  const url = `https://run.googleapis.com/v2/${serviceName}`;
  const response = await client.request({url, method: "GET"});
  return response.data || {};
}

async function getProjectId() {
  return process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || await auth.getProjectId();
}

function normalizeResources(payload) {
  return {
    cpu: cleanName(payload.cpu || DEFAULT_CPU),
    memory: cleanName(payload.memory || DEFAULT_MEMORY),
  };
}

function resourceLimits(resources) {
  return {
    cpu: resources.cpu,
    memory: resources.memory,
  };
}

function isIdleSession(session, now) {
  if (Number(session.activeSocketCount || 0) > 0) return false;
  const idleTimeoutMinutes = positiveNumber(
      session.idleTimeoutMinutes,
      DEFAULT_IDLE_TIMEOUT_MINUTES,
  );
  const idleSince = timestampMillis(
      session.lastDisconnectedAt ||
      session.lastActivityAt ||
      session.updatedAt ||
      session.createdAt,
  );
  if (!idleSince) return false;
  return now - idleSince >= idleTimeoutMinutes * 60 * 1000;
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (typeof value === "number") return value;
  return 0;
}

function storageFileToClientFile(file, queryPrefix) {
  const relativePath = file.name.slice(queryPrefix.length).replace(/^\/+/, "");
  if (!relativePath || relativePath.endsWith("/")) return null;
  if (relativePath === INTERNAL_STORAGE_DIR || relativePath.startsWith(`${INTERNAL_STORAGE_DIR}/`)) {
    return null;
  }
  if (relativePath.endsWith(`/${DIRECTORY_MARKER_FILE}`)) {
    const directoryPath = relativePath.slice(0, -(`/${DIRECTORY_MARKER_FILE}`).length);
    if (!directoryPath) return null;
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
  if (parts.includes(DIRECTORY_MARKER_FILE)) {
    throw httpError(400, "invalid_file_path");
  }
  if (parts[0] === INTERNAL_STORAGE_DIR) {
    throw httpError(400, "invalid_file_path");
  }
  return parts.join("/");
}

function normalizeGitActionPayloadPaths(payload) {
  const paths = payload && Array.isArray(payload.paths) ? payload.paths : null;
  if (!paths || !paths.length) {
    throw httpError(400, "invalid_git_paths");
  }
  return paths.map((value) => normalizeWorkspaceFilePath(value));
}

function normalizeGitCommitMessage(payload) {
  const message = cleanName(payload && payload.message ? payload.message : "").trim();
  if (!message) {
    throw httpError(400, "missing_commit_message");
  }
  return message;
}

function buildWorkingBranchName(value) {
  const slug = normalizeBranchDescription(value);
  return slug ? `mapache/${slug}` : "";
}

function normalizeBranchDescription(value) {
  return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
}

function normalizePullRequestTitle(value) {
  return String(value || "").trim().slice(0, 256);
}

function normalizePullRequestBody(value) {
  return String(value || "").trim().slice(0, 20000);
}

function contentTypeForPath(path) {
  const extension = path.split(".").pop().toLowerCase();
  const contentTypes = {
    css: "text/css; charset=utf-8",
    html: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    py: "text/x-python; charset=utf-8",
    sh: "text/x-shellscript; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    xml: "application/xml; charset=utf-8",
    yaml: "application/yaml; charset=utf-8",
    yml: "application/yaml; charset=utf-8",
  };
  return contentTypes[extension] || "text/plain; charset=utf-8";
}

function toClientDoc(doc) {
  return {id: doc.id, ...serialize(doc.data())};
}

function sortByUpdatedAtDesc(left, right) {
  return Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || "");
}

function serialize(value) {
  if (!value || typeof value !== "object") return value;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  return Object.entries(value).reduce((acc, [key, item]) => {
    acc[key] = serialize(item);
    return acc;
  }, {});
}

function cleanName(value) {
  return String(value || "").trim().slice(0, 256);
}

function positiveNumber(value, fallback) {
  const number = Number(value || fallback);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function slugify(value) {
  return cleanName(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
    "workspace";
}

function normalizeStoragePrefix(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function firebaseStorageBucket() {
  try {
    const config = JSON.parse(process.env.FIREBASE_CONFIG || "{}");
    return cleanName(config.storageBucket || "");
  } catch (error) {
    return "";
  }
}

function cloudRunServiceName(region, serviceId) {
  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "PROJECT_ID";
  return `projects/${project}/locations/${region}/services/${serviceId}`;
}

function publicGoogleError(error) {
  const message = error && error.response && error.response.data ?
    JSON.stringify(error.response.data) :
    error.message;
  return cleanName(message || "Cloud Run request failed.");
}

function isGoogleNotFound(error) {
  return error && (
    error.code === 404 ||
    error.status === 404 ||
    (error.response && error.response.status === 404) ||
    (error.response && error.response.data && error.response.data.error &&
      error.response.data.error.code === 404)
  );
}

function httpError(status, publicMessage, cause) {
  const error = new Error(publicMessage);
  error.status = status;
  error.publicMessage = publicMessage;
  if (cause) error.cause = cause;
  return error;
}
