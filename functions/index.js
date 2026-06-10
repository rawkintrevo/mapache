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
  const doc = {
    ownerUid: uid,
    userPath: userPath(uid),
    name,
    bucket,
    storagePrefix: `workspaces/${uid}/${slugify(name)}`,
    createdAt: now,
    updatedAt: now,
  };
  const ref = await db.collection("workspaces").add(doc);
  const snap = await ref.get();
  return toClientDoc(snap);
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
  await sessionRef.set(session);

  if (DEFAULT_IMAGE || payload.image) {
    await provisionSessionService(workspace, sessionRef, session);
  }

  return toClientDoc(await sessionRef.get());
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
    const body = buildCloudRunService(workspace, session);
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
          env: options.restart ? sessionRunnerEnv(session, {
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

function buildCloudRunService(workspace, session) {
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
          ...sessionRunnerEnv({
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

function sessionRunnerEnv(session, options = {}) {
  return [
    {name: "FIREBASE_PROJECT_ID", value: process.env.GCLOUD_PROJECT || ""},
    {name: "WORKSPACE_ID", value: session.workspaceId || ""},
    {name: "SESSION_ID", value: session.runnerSessionId || ""},
    {name: "STORAGE_BUCKET", value: session.workspaceStorageBucket || DEFAULT_BUCKET || ""},
    {name: "STORAGE_PREFIX", value: session.workspaceStoragePrefix || ""},
    {name: "SESSION_SHUTDOWN_TOKEN", value: session.shutdownToken || ""},
    options.restartNonce ? {name: "RESTART_NONCE", value: options.restartNonce} : null,
  ].filter(Boolean);
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
