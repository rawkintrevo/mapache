"use strict";

const admin = require("firebase-admin");
const {GoogleAuth} = require("google-auth-library");
const {onRequest} = require("firebase-functions/v2/https");
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
const DEFAULT_BUCKET = process.env.SESSION_BUCKET || "";

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

    res.status(404).json({error: "not_found"});
  } catch (error) {
    logger.error("api request failed", error);
    const status = error.status || 500;
    res.status(status).json({error: error.publicMessage || "internal_error"});
  }
});

function routeRequest(path) {
  const parts = path.replace(/^\/api\/?/, "/").split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "me") return {name: "me"};
  if (parts.length === 1 && parts[0] === "workspaces") return {name: "workspaces"};
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
  return {name: "unknown"};
}

async function requireUser(req) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) {
    throw httpError(401, "missing_auth_token");
  }
  try {
    const token = await admin.auth().verifyIdToken(match[1]);
    return await upsertUser(token);
  } catch (error) {
    throw httpError(401, "invalid_auth_token", error);
  }
}

async function upsertUser(token) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = db.collection("users").doc(token.uid);
  const profile = {
    uid: token.uid,
    email: cleanName(token.email || ""),
    displayName: cleanName(token.name || ""),
    photoURL: cleanName(token.picture || ""),
    providerIds: Array.isArray(token.firebase && token.firebase.identities) ?
      [] :
      Object.keys((token.firebase && token.firebase.identities) || {}),
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

async function createSession(uid, workspaceId, payload) {
  const workspace = await requireWorkspace(uid, workspaceId);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const sessionRef = sessionCollection(workspaceId).doc();
  const region = cleanName(payload.region || DEFAULT_REGION);
  const resources = normalizeResources(payload);
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
    resources,
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
    const env = [{name: "RESTART_NONCE", value: Date.now().toString()}];
    const body = {
      template: {
        containers: [{
          image: session.image,
          resources: {limits: resourceLimits(session.resources)},
          env: options.restart ? env : undefined,
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
          {name: "FIREBASE_PROJECT_ID", value: process.env.GCLOUD_PROJECT || ""},
          {name: "WORKSPACE_ID", value: workspace.id},
          {name: "SESSION_ID", value: session.runnerSessionId},
          {name: "STORAGE_BUCKET", value: workspace.bucket || DEFAULT_BUCKET || ""},
          {name: "STORAGE_PREFIX", value: workspace.storagePrefix || ""},
        ],
      }],
    },
  };
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

function slugify(value) {
  return cleanName(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
    "workspace";
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

function httpError(status, publicMessage, cause) {
  const error = new Error(publicMessage);
  error.status = status;
  error.publicMessage = publicMessage;
  if (cause) error.cause = cause;
  return error;
}
