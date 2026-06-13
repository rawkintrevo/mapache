"use strict";

const admin = require("firebase-admin");
const crypto = require("crypto");
const {GoogleAuth} = require("google-auth-library");
const {onRequest} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {setGlobalOptions} = require("firebase-functions/v2");
const {defineSecret} = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

admin.initializeApp();
setGlobalOptions({maxInstances: 10, region: process.env.FUNCTION_REGION || "us-central1"});

const db = admin.firestore();
const auth = new GoogleAuth({scopes: ["https://www.googleapis.com/auth/cloud-platform"]});
const GITHUB_APP_ID_SECRET = defineSecret("GITHUB_APP_ID");
const GITHUB_APP_CLIENT_ID_SECRET = defineSecret("GITHUB_APP_CLIENT_ID");
const GITHUB_APP_CLIENT_SECRET_SECRET = defineSecret("GITHUB_APP_CLIENT_SECRET");
const GITHUB_APP_PRIVATE_KEY_SECRET = defineSecret("GITHUB_APP_PRIVATE_KEY");

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
const MAX_WORKSPACE_TEXT_FILE_BYTES = 1024 * 1024;
const MAX_WORKSPACE_UPLOAD_BYTES = 10 * 1024 * 1024;
const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_SCOPE = "openid profile email offline_access";
const OPENAI_CODEX_DEVICE_USER_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const OPENAI_CODEX_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const OPENAI_CODEX_DEVICE_VERIFICATION_URI = "https://auth.openai.com/codex/device";
const OPENAI_CODEX_DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const OPENAI_CODEX_ACCOUNT_CLAIM_PATH = "https://api.openai.com/auth";
const PI_AUTH_API_KEY_PROVIDERS = new Set([
  "anthropic",
  "ant-ling",
  "azure-openai-responses",
  "openai",
  "deepseek",
  "nvidia",
  "google",
  "mistral",
  "groq",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "xai",
  "openrouter",
  "vercel-ai-gateway",
  "zai",
  "zai-coding-cn",
  "opencode",
  "opencode-go",
  "huggingface",
  "fireworks",
  "together",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
]);

exports.api = onRequest({
  cors: true,
  secrets: [
    GITHUB_APP_ID_SECRET,
    GITHUB_APP_CLIENT_ID_SECRET,
    GITHUB_APP_CLIENT_SECRET_SECRET,
    GITHUB_APP_PRIVATE_KEY_SECRET,
  ],
}, async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    const route = routeRequest(req.path);

    if (req.method === "GET" && route.name === "githubCallback") {
      await handleGithubCallback(req, res);
      return;
    }

    const user = await requireUser(req);

    if (req.method === "GET" && route.name === "me") {
      res.json({user: await userWithUsage(user)});
      return;
    }

    if (req.method === "GET" && route.name === "piAuth") {
      res.json(await getPiAuth(user.uid));
      return;
    }

    if (req.method === "PUT" && route.name === "piAuthProvider") {
      res.json(await savePiAuthProvider(user.uid, route.provider, req.body || {}));
      return;
    }

    if (req.method === "DELETE" && route.name === "piAuthProvider") {
      res.json(await deletePiAuthProvider(user.uid, route.provider));
      return;
    }

    if (req.method === "POST" && route.name === "openAiCodexDeviceCode" && route.action === "start") {
      res.json(await startOpenAiCodexDeviceCode());
      return;
    }

    if (req.method === "POST" && route.name === "openAiCodexDeviceCode" && route.action === "complete") {
      res.json(await completeOpenAiCodexDeviceCode(user.uid, req.body || {}));
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

    if (req.method === "POST" && route.name === "workspaceFile") {
      res.status(201).json(await uploadWorkspaceFile(user.uid, route.workspaceId, req.query.path, req));
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

    if (req.method === "DELETE" && route.name === "session") {
      res.json(await deleteSession(user.uid, route.workspaceId, route.sessionId));
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

    if (req.method === "GET" && route.name === "piPackages") {
      res.json(await listPiPackages(user.uid, route.workspaceId, route.sessionId));
      return;
    }

    if (req.method === "POST" && route.name === "piPackageInstall") {
      res.json(await installPiPackage(user.uid, route.workspaceId, route.sessionId, req.body || {}));
      return;
    }

    if (req.method === "POST" && route.name === "piPackageRemove") {
      res.json(await removePiPackage(user.uid, route.workspaceId, route.sessionId, req.body || {}));
      return;
    }

    if (req.method === "POST" && route.name === "piPackageUpdate") {
      res.json(await updatePiPackage(user.uid, route.workspaceId, route.sessionId, req.body || {}));
      return;
    }

    if (req.method === "GET" && route.name === "piSkills") {
      res.json(await listPiSkills(user.uid, route.workspaceId, route.sessionId));
      return;
    }

    if (req.method === "POST" && route.name === "piSkills") {
      res.json(await savePiSkill(user.uid, route.workspaceId, route.sessionId, req.body || {}));
      return;
    }

    if (req.method === "POST" && route.name === "piSkillDelete") {
      res.json(await deletePiSkill(user.uid, route.workspaceId, route.sessionId, req.body || {}));
      return;
    }

    if (req.method === "GET" && route.name === "githubRepos") {
      res.json(await listConnectedRepos(user.uid));
      return;
    }

    if (req.method === "GET" && route.name === "githubConnect") {
      res.json(await createGithubConnectUrl(user.uid, req));
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
  if (parts.length === 1 && parts[0] === "pi-auth") return {name: "piAuth"};
  if (parts.length === 3 && parts[0] === "pi-auth" && parts[1] === "providers") {
    return {name: "piAuthProvider", provider: parts[2]};
  }
  if (
    parts.length === 5 &&

    parts[0] === "pi-auth" &&
    parts[1] === "providers" &&
    parts[2] === OPENAI_CODEX_PROVIDER &&
    parts[3] === "device-code"
  ) {
    return {name: "openAiCodexDeviceCode", action: parts[4]};
  }
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
  if (parts.length === 4 && parts[0] === "workspaces" && parts[2] === "sessions") {
    return {name: "session", workspaceId: parts[1], sessionId: parts[3]};
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
  if (
    parts.length === 5 &&
    parts[0] === "workspaces" &&
    parts[2] === "sessions" &&
    parts[4] === "pi-packages"
  ) {
    return {name: "piPackages", workspaceId: parts[1], sessionId: parts[3]};
  }
  if (
    parts.length === 6 &&
    parts[0] === "workspaces" &&
    parts[2] === "sessions" &&
    parts[4] === "pi-packages" &&
    parts[5] === "install"
  ) {
    return {name: "piPackageInstall", workspaceId: parts[1], sessionId: parts[3]};
  }
  if (
    parts.length === 6 &&
    parts[0] === "workspaces" &&
    parts[2] === "sessions" &&
    parts[4] === "pi-packages" &&
    parts[5] === "remove"
  ) {
    return {name: "piPackageRemove", workspaceId: parts[1], sessionId: parts[3]};
  }
  if (
    parts.length === 6 &&
    parts[0] === "workspaces" &&
    parts[2] === "sessions" &&
    parts[4] === "pi-packages" &&
    parts[5] === "update"
  ) {
    return {name: "piPackageUpdate", workspaceId: parts[1], sessionId: parts[3]};
  }
  if (
    parts.length === 5 &&
    parts[0] === "workspaces" &&
    parts[2] === "sessions" &&
    parts[4] === "pi-skills"
  ) {
    return {name: "piSkills", workspaceId: parts[1], sessionId: parts[3]};
  }
  if (
    parts.length === 6 &&
    parts[0] === "workspaces" &&
    parts[2] === "sessions" &&
    parts[4] === "pi-skills" &&
    parts[5] === "delete"
  ) {
    return {name: "piSkillDelete", workspaceId: parts[1], sessionId: parts[3]};
  }
  if (parts.length === 2 && parts[0] === "github" && parts[1] === "connect") {
    return {name: "githubConnect"};
  }
  if (parts.length === 2 && parts[0] === "github" && parts[1] === "callback") {
    return {name: "githubCallback"};
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

async function userWithUsage(user) {
  return {
    ...user,
    usage: await getUserSessionUsage(user.uid),
  };
}

async function getUserSessionUsage(uid) {
  const now = Date.now();
  const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
  const totals = createUsageTotals();
  const last30Days = createUsageTotals();

  const [ledgerSnap, sessionDocs] = await Promise.all([
    db.collection("users").doc(uid).collection("sessionUsage").get(),
    listUserSessionDocs(uid),
  ]);

  ledgerSnap.docs.forEach((doc) => {
    const entry = doc.data();
    addUsageTotals(totals, entry);
    addUsageTotals(last30Days, prorateUsageEntry(entry, thirtyDaysAgo, now));
  });

  sessionDocs.forEach((doc) => {
    const session = doc.data();
    if (session.usageAccountedAt) return;
    const entry = sessionUsageEntry(doc.id, session, now);
    if (!entry) return;
    addUsageTotals(totals, entry);
    addUsageTotals(last30Days, prorateUsageEntry(entry, thirtyDaysAgo, now));
  });

  return {
    lifetime: roundUsageTotals(totals),
    last30Days: roundUsageTotals(last30Days),
  };
}

async function listUserSessionDocs(uid) {
  try {
    const snap = await db.collectionGroup("sessions")
        .where("ownerUid", "==", uid)
        .get();
    return snap.docs;
  } catch (error) {
    if (!isMissingIndexError(error)) throw error;
    logger.warn("sessions collection group index not ready; falling back to workspace session scan", {
      uid,
      error: error.message,
    });
    return listUserSessionDocsByWorkspace(uid);
  }
}

async function listUserSessionDocsByWorkspace(uid) {
  const workspaceSnap = await db.collection("workspaces")
      .where("ownerUid", "==", uid)
      .get();
  const sessionSnaps = await Promise.all(
      workspaceSnap.docs.map((doc) => doc.ref.collection("sessions").get()),
  );
  return sessionSnaps.flatMap((snap) => snap.docs);
}

function isMissingIndexError(error) {
  const message = cleanName(error && error.message).toLowerCase();
  return error && (error.code === 9 || error.code === "failed-precondition") &&
    message.includes("index");
}

function createUsageTotals() {
  return {
    cpuSeconds: 0,
    memoryGbSeconds: 0,
    runtimeSeconds: 0,
    sessionCount: 0,
  };
}

function addUsageTotals(target, usage) {
  if (!usage) return;
  target.cpuSeconds += Number(usage.cpuSeconds || 0);
  target.memoryGbSeconds += Number(usage.memoryGbSeconds || 0);
  target.runtimeSeconds += Number(usage.runtimeSeconds || 0);
  target.sessionCount += Number(usage.sessionCount || 0) || (usage.runtimeSeconds > 0 ? 1 : 0);
}

function roundUsageTotals(totals) {
  return {
    cpuSeconds: Math.round(totals.cpuSeconds),
    memoryGbSeconds: Math.round(totals.memoryGbSeconds),
    runtimeSeconds: Math.round(totals.runtimeSeconds),
    sessionCount: Math.round(totals.sessionCount),
  };
}

function sessionUsageEntry(sessionId, session, fallbackEndMs = Date.now()) {
  const startedMs = timestampMillis(session.createdAt);
  if (!startedMs) return null;

  const endedMs = timestampMillis(session.stoppedAt) ||
    (isTerminalSessionStatus(session.status) ? timestampMillis(session.updatedAt) : 0) ||
    fallbackEndMs;
  if (!endedMs || endedMs <= startedMs) return null;

  const intervalStartMs = Math.max(startedMs, timestampMillis(session.usageAccruedAt) || startedMs);
  const intervalSeconds = Math.max(0, (endedMs - intervalStartMs) / 1000);
  const cpu = parseCpuCount(session.resources && session.resources.cpu);
  const memoryGb = parseMemoryGb(session.resources && session.resources.memory);
  const runtimeSeconds = (endedMs - startedMs) / 1000;
  const accruedCpuSeconds = Number(session.usageAccruedCpuSeconds || 0);
  const accruedMemoryGbSeconds = Number(session.usageAccruedMemoryGbSeconds || 0);

  return {
    sessionId,
    workspaceId: cleanName(session.workspaceId || ""),
    startedAt: admin.firestore.Timestamp.fromMillis(startedMs),
    endedAt: admin.firestore.Timestamp.fromMillis(endedMs),
    cpu,
    memoryGb,
    runtimeSeconds,
    cpuSeconds: accruedCpuSeconds + (intervalSeconds * cpu),
    memoryGbSeconds: accruedMemoryGbSeconds + (intervalSeconds * memoryGb),
    sessionCount: 1,
  };
}

function accrueSessionUsage(session, accruedAt) {
  const current = sessionUsageEntry(
      cleanName(session.runnerSessionId || ""),
      session,
      accruedAt.toMillis(),
  );

  return {
    usageAccruedAt: accruedAt,
    usageAccruedCpuSeconds: current ? current.cpuSeconds : Number(session.usageAccruedCpuSeconds || 0),
    usageAccruedMemoryGbSeconds: current ?
      current.memoryGbSeconds :
      Number(session.usageAccruedMemoryGbSeconds || 0),
    usageAccruedRuntimeSeconds: current ?
      current.runtimeSeconds :
      Number(session.usageAccruedRuntimeSeconds || 0),
  };
}

function prorateUsageEntry(entry, windowStartMs, windowEndMs) {
  const startedMs = timestampMillis(entry.startedAt);
  const endedMs = timestampMillis(entry.endedAt);
  if (!startedMs || !endedMs || endedMs <= windowStartMs || startedMs >= windowEndMs) {
    return null;
  }

  const overlapStart = Math.max(startedMs, windowStartMs);
  const overlapEnd = Math.min(endedMs, windowEndMs);
  const overlapSeconds = Math.max(0, (overlapEnd - overlapStart) / 1000);
  const runtimeSeconds = Number(entry.runtimeSeconds || 0);
  const ratio = runtimeSeconds > 0 ? Math.min(1, overlapSeconds / runtimeSeconds) : 0;

  return {
    runtimeSeconds: overlapSeconds,
    cpuSeconds: Number(entry.cpuSeconds || 0) * ratio,
    memoryGbSeconds: Number(entry.memoryGbSeconds || 0) * ratio,
    sessionCount: overlapSeconds > 0 ? 1 : 0,
  };
}

function sessionUsageRecord(sessionRef, session, endedAt) {
  if (!session || session.usageAccountedAt || !session.ownerUid) return null;
  const entry = sessionUsageEntry(sessionRef.id, session, endedAt.toMillis());
  if (!entry) return null;

  const userUsageRef = db.collection("users")
      .doc(session.ownerUid)
      .collection("sessionUsage")
      .doc(sessionRef.id);

  return {
    ref: userUsageRef,
    data: {
      ...entry,
      ownerUid: session.ownerUid,
      recordedAt: endedAt,
    },
  };
}

async function getPiAuth(uid) {
  const snap = await piAuthDoc(uid).get();
  const data = snap.exists ? snap.data() : {};
  return {providers: normalizePiAuthProviders(data.providers)};
}

async function savePiAuthProvider(uid, provider, payload) {
  const providerKey = normalizePiAuthProviderKey(provider);
  const apiKey = normalizePiAuthApiKey(payload && payload.key);
  await savePiAuthCredential(uid, providerKey, {type: "api_key", key: apiKey});
  return getPiAuth(uid);
}

async function deletePiAuthProvider(uid, provider) {
  const providerKey = normalizePiAuthStoredProviderKey(provider);
  const ref = piAuthDoc(uid);
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const current = snap.exists ? normalizePiAuthProviders(snap.data().providers) : {};
    delete current[providerKey];
    transaction.set(ref, {
      providers: current,
      updatedAt: now,
      ...(snap.exists ? {} : {createdAt: now}),
    }, {merge: true});
  });
  return getPiAuth(uid);
}

async function savePiAuthCredential(uid, providerKey, credential) {
  const ref = piAuthDoc(uid);
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const current = snap.exists ? normalizePiAuthProviders(snap.data().providers) : {};
    transaction.set(ref, {
      providers: {
        ...current,
        [providerKey]: normalizePlainObject(credential),
      },
      updatedAt: now,
      ...(snap.exists ? {} : {createdAt: now}),
    }, {merge: true});
  });
}

async function startOpenAiCodexOAuth(uid, payload) {
  const returnTo = normalizeOpenAiCodexReturnTo(payload.returnTo);
  const redirectUri = `${new URL(returnTo).origin}/api/pi-auth/providers/${OPENAI_CODEX_PROVIDER}/callback`;
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  const expiresAt = Date.now() + 15 * 60 * 1000;

  await openAiCodexOAuthStateDoc(state).set({
    uid,
    verifier,
    redirectUri,
    returnTo,
    expiresAt,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const url = new URL(OPENAI_CODEX_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OPENAI_CODEX_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", OPENAI_CODEX_SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "pi");

  return {authUrl: url.toString(), redirectUri};
}

async function handleOpenAiCodexOAuthCallback(req, res) {
  const state = String(req.query.state || "").trim();
  const code = String(req.query.code || "").trim();
  const providerError = String(req.query.error || "").trim();
  const ref = openAiCodexOAuthStateDoc(state);
  const snap = state ? await ref.get() : null;
  const record = snap && snap.exists ? snap.data() : null;
  const returnTo = record?.returnTo || "/";

  try {
    if (!record) throw httpError(400, "openai_codex_oauth_state_not_found");
    if (Number(record.expiresAt || 0) < Date.now()) throw httpError(400, "openai_codex_oauth_state_expired");
    if (providerError) throw httpError(400, `openai_codex_oauth_error: ${providerError}`);
    if (!code) throw httpError(400, "openai_codex_oauth_missing_code");

    const oauth = await exchangeOpenAiCodexAuthorizationCode(code, record.verifier, record.redirectUri);
    await savePiAuthCredential(record.uid, OPENAI_CODEX_PROVIDER, {type: "oauth", ...oauth});
    await ref.delete().catch(() => {});
    res.redirect(303, appendQuery(returnTo, {openAiCodexLogin: "success"}));
  } catch (error) {
    logger.error("openai codex oauth callback failed", error);
    await ref.delete().catch(() => {});
    res.redirect(303, appendQuery(returnTo, {
      openAiCodexLogin: "error",
      error: publicErrorMessage(error),
    }));
  }
}

async function startOpenAiCodexDeviceCode() {
  const response = await fetch(OPENAI_CODEX_DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({client_id: OPENAI_CODEX_CLIENT_ID}),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw httpError(502, `openai_codex_device_code_failed${text ? `: ${text}` : ""}`);
  }

  const data = await response.json();
  const intervalSeconds = typeof data.interval === "string" ? Number(data.interval.trim()) : data.interval;
  if (!data.device_auth_id || !data.user_code || !Number.isFinite(intervalSeconds)) {
    throw httpError(502, "openai_codex_device_code_invalid_response");
  }

  return {
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    verificationUri: OPENAI_CODEX_DEVICE_VERIFICATION_URI,
    intervalSeconds: Math.max(1, intervalSeconds),
    expiresInSeconds: 15 * 60,
  };
}

async function completeOpenAiCodexDeviceCode(uid, payload) {
  const deviceAuthId = cleanOpenAiCodexDeviceField(payload.deviceAuthId);
  const userCode = cleanOpenAiCodexDeviceField(payload.userCode);
  if (!deviceAuthId || !userCode) throw httpError(400, "invalid_openai_codex_device_code");

  const tokenResponse = await fetch(OPENAI_CODEX_DEVICE_TOKEN_URL, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({device_auth_id: deviceAuthId, user_code: userCode}),
  });

  if (!tokenResponse.ok) {
    if (tokenResponse.status === 403 || tokenResponse.status === 404) {
      return {status: "pending"};
    }
    const text = await tokenResponse.text().catch(() => "");
    const errorCode = parseOpenAiCodexErrorCode(text);
    if (errorCode === "deviceauth_authorization_pending" || errorCode === "slow_down") {
      return {status: "pending"};
    }
    throw httpError(502, `openai_codex_device_poll_failed${text ? `: ${text}` : ""}`);
  }

  const deviceToken = await tokenResponse.json();
  if (!deviceToken.authorization_code || !deviceToken.code_verifier) {
    throw httpError(502, "openai_codex_device_token_invalid_response");
  }

  const oauth = await exchangeOpenAiCodexAuthorizationCode(
      deviceToken.authorization_code,
      deviceToken.code_verifier,
  );
  await savePiAuthCredential(uid, OPENAI_CODEX_PROVIDER, {type: "oauth", ...oauth});
  return {status: "complete", ...(await getPiAuth(uid))};
}

async function exchangeOpenAiCodexAuthorizationCode(code, verifier, redirectUri = OPENAI_CODEX_DEVICE_REDIRECT_URI) {
  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw httpError(502, `openai_codex_token_exchange_failed${text ? `: ${text}` : ""}`);
  }

  const data = await response.json();
  if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
    throw httpError(502, "openai_codex_token_invalid_response");
  }

  const accountId = openAiCodexAccountId(data.access_token);
  if (!accountId) throw httpError(502, "openai_codex_missing_account_id");
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
    accountId,
  };
}

function normalizeOpenAiCodexReturnTo(value) {
  const text = String(value || "").trim();
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("invalid protocol");
    url.hash = "";
    return url.toString();
  } catch (error) {
    throw httpError(400, "invalid_openai_codex_return_url");
  }
}

function openAiCodexOAuthStateDoc(state) {
  return db.collection("oauthStates").doc(`${OPENAI_CODEX_PROVIDER}-${state}`);
}

function base64Url(buffer) {
  return Buffer.from(buffer)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
}

function appendQuery(url, params) {
  try {
    const parsed = new URL(url);
    Object.entries(params).forEach(([key, value]) => parsed.searchParams.set(key, String(value || "")));
    return parsed.toString();
  } catch (error) {
    const query = new URLSearchParams(params).toString();
    return `/?${query}`;
  }
}

function publicErrorMessage(error) {
  return error?.publicMessage || error?.message || "openai_codex_oauth_failed";
}

function cleanOpenAiCodexDeviceField(value) {
  const text = String(value || "").trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text) || text.length > 2048) return "";
  return text;
}

function parseOpenAiCodexErrorCode(text) {
  try {
    const data = JSON.parse(text || "{}");
    const error = data && data.error;
    if (typeof error === "string") return error;
    if (error && typeof error.code === "string") return error.code;
  } catch (error) {
    return "";
  }
  return "";
}

function openAiCodexAccountId(accessToken) {
  try {
    const parts = String(accessToken || "").split(".");
    if (parts.length !== 3) return "";
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const claim = payload && payload[OPENAI_CODEX_ACCOUNT_CLAIM_PATH];
    return typeof claim?.chatgpt_account_id === "string" ? claim.chatgpt_account_id : "";
  } catch (error) {
    return "";
  }
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
    piHomeStorageBucket: DEFAULT_BUCKET || workspace.bucket,
    piHomeStoragePrefix: piHomeStoragePrefix(uid),
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
    usageAccruedAt: now,
    usageAccruedCpuSeconds: 0,
    usageAccruedMemoryGbSeconds: 0,
    usageAccruedRuntimeSeconds: 0,
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
  const resizedAt = admin.firestore.Timestamp.now();
  await sessionRef.update({
    ...accrueSessionUsage(sessionSnap.data(), resizedAt),
    resources,
    status: "resizing",
    updatedAt: resizedAt,
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

async function deleteSession(uid, workspaceId, sessionId) {
  const {sessionRef, sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  await sessionRef.update({
    status: "deleting",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const serviceDeleted = await deleteSessionService(sessionRef, sessionSnap.data(), {reason: "deleted"});
  if (!serviceDeleted) {
    throw httpError(502, "session_delete_failed");
  }
  await sessionRef.delete();
  return {ok: true};
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

async function installPiPackage(uid, workspaceId, sessionId, payload) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const packageSource = normalizePiPackageSource(payload.source);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_package_install_unsupported");
  const result = await requestRunnerPiPackageInstall(session, {source: packageSource.source});
  await mergeInstalledPiPackageCatalogEntry(uid, workspaceId, packageSource.source);
  return result;
}

async function mergeInstalledPiPackageCatalogEntry(uid, workspaceId, source) {
  const normalized = normalizePiPackageSource(source);
  const ref = piPackageCatalogCollection(uid).doc(piPackageCatalogDocId(normalized.identity));
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    transaction.set(ref, piPackageCatalogRecord(source, workspaceId, {
      includeCreatedAt: !snap.exists,
      incrementInstallCount: true,
    }), {merge: true});
  });
}

async function removePiPackage(uid, workspaceId, sessionId, payload) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const packageSource = normalizePiPackageSource(payload.source);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_package_remove_unsupported");
  return requestRunnerPiPackageRemove(session, {source: packageSource.source});
}

async function updatePiPackage(uid, workspaceId, sessionId, payload) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const packageSource = payload.source ? normalizePiPackageSource(payload.source) : null;
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_package_update_unsupported");
  return requestRunnerPiPackageUpdate(session, packageSource ? {source: packageSource.source} : {});
}

async function listPiPackages(uid, workspaceId, sessionId) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_package_listing_unsupported");
  const data = await requestRunnerPiPackages(session);
  await recordObservedPiPackages(uid, workspaceId, data).catch((error) => {
    logger.warn("observed package catalog update failed", {workspaceId, sessionId, error: error.message || error});
  });
  const knownPackages = await listKnownPiPackages(uid, data).catch((error) => {
    logger.warn("known package catalog read failed", {workspaceId, sessionId, error: error.message || error});
    return [];
  });
  return {...data, knownPackages};
}

async function listPiSkills(uid, workspaceId, sessionId) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_skill_listing_unsupported");
  return requestRunnerPiSkills(session);
}

async function savePiSkill(uid, workspaceId, sessionId, payload) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const skill = normalizePiSkillPayload(payload);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_skill_save_unsupported");
  return requestRunnerPiSkillSave(session, skill);
}

async function deletePiSkill(uid, workspaceId, sessionId, payload) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const skillName = normalizePiSkillName(payload.name);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_skill_delete_unsupported");
  return requestRunnerPiSkillDelete(session, {name: skillName});
}

async function listKnownPiPackages(uid, data) {
  const configuredSources = new Set((data && Array.isArray(data.packages) ? data.packages : [])
      .map((packageInfo) => packageInfo && packageInfo.source)
      .filter(Boolean));
  const snap = await piPackageCatalogCollection(uid).get();
  return snap.docs
      .map((doc) => ({id: doc.id, ...doc.data()}))
      .filter((packageInfo) => packageInfo.source && !configuredSources.has(packageInfo.source))
      .map((packageInfo) => ({
        source: packageInfo.source,
        identity: packageInfo.identity || "",
        type: packageInfo.type || "",
        favorite: Boolean(packageInfo.favorite),
        lastWorkspaceId: packageInfo.lastWorkspaceId || "",
        installCount: Number(packageInfo.installCount || 0),
      }))
      .sort((left, right) => left.source.localeCompare(right.source));
}

async function recordObservedPiPackages(uid, workspaceId, data) {
  const packages = data && Array.isArray(data.packages) ? data.packages : [];
  const results = await Promise.allSettled(packages.map((packageInfo) => (
    mergeObservedPiPackageCatalogEntry(uid, workspaceId, packageInfo && packageInfo.source)
  )));
  results
      .filter((result) => result.status === "rejected")
      .forEach((result) => logger.warn("skipped observed package catalog entry", {
        workspaceId,
        error: result.reason && result.reason.message ? result.reason.message : result.reason,
      }));
}

async function mergeObservedPiPackageCatalogEntry(uid, workspaceId, source) {
  if (!source) return null;
  const normalized = normalizePiPackageSource(source);
  const ref = piPackageCatalogCollection(uid).doc(piPackageCatalogDocId(normalized.identity));
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    transaction.set(ref, piPackageCatalogRecord(source, workspaceId, {
      includeCreatedAt: !snap.exists,
      incrementInstallCount: false,
    }), {merge: true});
  });
  return normalized;
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

async function createGithubConnectUrl(uid, req) {
  if (!isGithubOAuthConfigured()) {
    throw httpError(503, "github_oauth_not_configured");
  }

  const state = crypto.randomBytes(24).toString("base64url");
  const now = admin.firestore.FieldValue.serverTimestamp();
  await githubOAuthStateDoc(state).set({
    uid,
    returnTo: normalizeGithubReturnTo(req.query.returnTo || req.get("referer") || req.get("origin")),
    createdAt: now,
    expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + (10 * 60 * 1000)),
  });

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", githubClientId());
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", githubCallbackUrl(req));
  return {url: url.toString()};
}

async function handleGithubCallback(req, res) {
  const code = cleanGithubValue(req.query.code);
  const state = cleanGithubValue(req.query.state);
  if (!code || !state) {
    res.status(400).send("Missing GitHub authorization code or state.");
    return;
  }
  if (!isGithubOAuthConfigured()) {
    res.status(503).send("GitHub OAuth is not configured.");
    return;
  }

  const stateRef = githubOAuthStateDoc(state);
  const stateSnap = await stateRef.get();
  if (!stateSnap.exists) {
    res.status(400).send("GitHub authorization state expired or was not found.");
    return;
  }

  const stateData = stateSnap.data() || {};
  await stateRef.delete();
  const uid = cleanGithubValue(stateData.uid);
  if (!uid || githubStateExpired(stateData)) {
    res.status(400).send("GitHub authorization state expired or was invalid.");
    return;
  }

  const tokenResponse = await exchangeGithubOAuthCode(code, githubCallbackUrl(req));
  const accessToken = cleanGithubToken(tokenResponse.access_token);
  if (!accessToken) {
    throw httpError(502, "github_oauth_token_failed");
  }

  const [githubUser, installations] = await Promise.all([
    requestGithubJson("https://api.github.com/user", accessToken, {
      failureError: "github_user_lookup_failed",
    }),
    listGithubUserInstallations(accessToken),
  ]);
  await storeGithubConnection(uid, githubUser, installations);

  const redirectTo = cleanGithubValue(stateData.returnTo) || "/";
  res.status(302).set("Location", redirectTo).send("GitHub connected.");
}

function isGithubOAuthConfigured() {
  return Boolean(githubClientId() && githubClientSecret());
}

function githubCallbackUrl(req) {
  const host = req.get("x-forwarded-host") || req.get("host") || "";
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  return `${proto}://${host}/api/github/callback`;
}

function normalizeGithubReturnTo(value) {
  const fallback = "/";
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return fallback;
  }
  try {
    const url = new URL(rawValue);
    if (url.protocol === "https:" || url.protocol === "http:") {
      return url.toString().slice(0, 512);
    }
  } catch (error) {
    return fallback;
  }
  return fallback;
}

function githubStateExpired(value) {
  const expiresAt = value && value.expiresAt;
  return expiresAt && typeof expiresAt.toMillis === "function" && expiresAt.toMillis() < Date.now();
}

async function exchangeGithubOAuthCode(code, redirectUri) {
  let response;
  try {
    response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "user-agent": "mapahce-functions",
      },
      body: JSON.stringify({
        client_id: githubClientId(),
        client_secret: githubClientSecret(),
        code,
        redirect_uri: redirectUri,
      }),
    });
  } catch (error) {
    throw httpError(502, "github_oauth_token_failed", error);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    logger.error("github oauth token exchange failed", {
      status: response.status,
      error: cleanGithubValue(data.error),
      errorDescription: cleanGithubValue(data.error_description),
    });
    throw httpError(502, "github_oauth_token_failed");
  }
  return data;
}

async function listGithubUserInstallations(token) {
  const installations = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = new URL("https://api.github.com/user/installations");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const data = await requestGithubJson(url.toString(), token, {
      failureError: "github_user_installations_failed",
    });
    const pageInstallations = Array.isArray(data && data.installations) ? data.installations : [];
    installations.push(...pageInstallations);
    if (pageInstallations.length < 100) {
      break;
    }
  }
  return installations;
}

async function storeGithubConnection(uid, githubUser, installations) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const installationIds = installations
      .map((installation) => cleanGithubNumericId(installation && installation.id))
      .filter(Boolean);
  const batch = db.batch();
  batch.set(githubUserDoc(uid), {
    firebaseUid: uid,
    githubUserId: cleanGithubNumericId(githubUser && githubUser.id),
    githubLogin: cleanGithubValue(githubUser && githubUser.login),
    displayName: cleanGithubValue(githubUser && githubUser.name),
    avatarUrl: cleanGithubValue(githubUser && githubUser.avatar_url),
    connectionStatus: "connected",
    installationIds,
    updatedAt: now,
    lastSyncedAt: now,
    createdAt: now,
  }, {merge: true});

  installations.forEach((installation) => {
    const installationId = cleanGithubNumericId(installation && installation.id);
    if (!installationId) return;
    const account = installation.account || {};
    batch.set(githubInstallationCollection(uid).doc(installationId), {
      installationId,
      ownerUid: uid,
      githubAccountId: cleanGithubNumericId(account.id),
      githubAccountLogin: cleanGithubValue(account.login),
      githubAccountType: cleanGithubValue(account.type),
      repositorySelection: cleanGithubValue(installation.repository_selection),
      appId: cleanGithubNumericId(installation.app_id),
      permissionSet: normalizeGithubTokenPermissions(installation.permissions),
      installationStatus: "active",
      webhookConfigured: true,
      updatedAt: now,
      lastSyncedAt: now,
      createdAt: now,
      removedAt: null,
    }, {merge: true});
  });

  await batch.commit();
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
  return Boolean(normalizeGithubAppId(githubAppId()) && normalizeGithubPrivateKey());
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
  const key = String(githubPrivateKey() || "").trim();
  return key ? key.replace(/\\n/g, "\n") : "";
}

function createGithubAppJwt() {
  const appId = normalizeGithubAppId(githubAppId());
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

function githubAppId() {
  return secretValue(GITHUB_APP_ID_SECRET) || process.env.GITHUB_APP_ID || "";
}

function githubClientId() {
  return secretValue(GITHUB_APP_CLIENT_ID_SECRET) || process.env.GITHUB_APP_CLIENT_ID || "";
}

function githubClientSecret() {
  return secretValue(GITHUB_APP_CLIENT_SECRET_SECRET) || process.env.GITHUB_APP_CLIENT_SECRET || "";
}

function githubPrivateKey() {
  return secretValue(GITHUB_APP_PRIVATE_KEY_SECRET) || process.env.GITHUB_APP_PRIVATE_KEY || "";
}

function secretValue(secret) {
  try {
    return secret.value();
  } catch (error) {
    return "";
  }
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

function githubOAuthStateDoc(state) {
  return db.collection("githubOAuthStates").doc(state);
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

function piHomeStoragePrefix(uid) {
  const cleanUid = cleanName(uid);
  return cleanUid ? `users/${cleanUid}/.mapahce-internal/pi-home` : "";
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
    await markSessionStopped(sessionRef, session, options.reason);
    return true;
  }

  try {
    await requestRunnerShutdown(session);
    const client = await auth.getClient();
    const url = `https://run.googleapis.com/v2/${session.serviceName}`;
    const response = await client.request({url, method: "DELETE"});
    await waitForOperation(client, response.data);
    await markSessionStopped(sessionRef, session, options.reason);
    return true;
  } catch (error) {
    if (isGoogleNotFound(error)) {
      await markSessionStopped(sessionRef, session, options.reason);
      return true;
    }

    await sessionRef.update({
      status: "stop_failed",
      lastError: publicGoogleError(error),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return false;
  }
}

async function markSessionStopped(sessionRef, session, reason) {
  const stoppedAt = admin.firestore.Timestamp.now();
  const usageRecord = sessionUsageRecord(sessionRef, session, stoppedAt);
  const stopped = {
    status: "stopped",
    activeSocketCount: 0,
    serviceUrl: null,
    stoppedAt,
    lastError: null,
    updatedAt: stoppedAt,
  };
  if (reason) stopped.stopReason = reason;
  if (reason === "idle_timeout") {
    stopped.autoStoppedAt = stoppedAt;
  }
  if (usageRecord) {
    stopped.usageAccountedAt = stoppedAt;
    const batch = db.batch();
    batch.set(usageRecord.ref, usageRecord.data, {merge: true});
    batch.update(sessionRef, stopped);
    await batch.commit();
    return;
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
    {name: "OWNER_UID", value: session.ownerUid || ""},
    {name: "WORKSPACE_ID", value: session.workspaceId || ""},
    {name: "SESSION_ID", value: session.runnerSessionId || ""},
    {name: "STORAGE_BUCKET", value: session.workspaceStorageBucket || DEFAULT_BUCKET || ""},
    {name: "STORAGE_PREFIX", value: session.workspaceStoragePrefix || ""},
    {name: "PI_HOME_STORAGE_BUCKET", value: session.piHomeStorageBucket || DEFAULT_BUCKET || ""},
    {name: "PI_HOME_STORAGE_PREFIX", value: session.piHomeStoragePrefix || piHomeStoragePrefix(session.ownerUid)},
    {name: "PI_CODING_AGENT_DIR", value: "/root/.pi/agent"},
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

async function requestRunnerPiPackages(session) {
  return requestRunnerJson(session, "/pi/packages", {
    notFoundError: "runner_package_listing_unsupported",
    notFoundStatus: 501,
    failureError: "pi_package_read_failed",
    unavailableError: "runner_package_list_unavailable",
  });
}

async function requestRunnerPiPackageInstall(session, body) {
  return requestRunnerJson(session, "/pi/packages/install", {
    method: "POST",
    body,
    notFoundError: "runner_package_install_unsupported",
    notFoundStatus: 501,
    failureError: "pi_package_install_failed",
    unavailableError: "runner_package_install_unavailable",
    timeoutMs: 120000,
  });
}

async function requestRunnerPiPackageRemove(session, body) {
  return requestRunnerJson(session, "/pi/packages/remove", {
    method: "POST",
    body,
    notFoundError: "runner_package_remove_unsupported",
    notFoundStatus: 501,
    failureError: "pi_package_remove_failed",
    unavailableError: "runner_package_remove_unavailable",
    timeoutMs: 120000,
  });
}

async function requestRunnerPiPackageUpdate(session, body) {
  return requestRunnerJson(session, "/pi/packages/update", {
    method: "POST",
    body,
    notFoundError: "runner_package_update_unsupported",
    notFoundStatus: 501,
    failureError: "pi_package_update_failed",
    unavailableError: "runner_package_update_unavailable",
    timeoutMs: 120000,
  });
}

async function requestRunnerPiSkills(session) {
  return requestRunnerJson(session, "/pi/skills", {
    notFoundError: "runner_skill_listing_unsupported",
    notFoundStatus: 501,
    failureError: "pi_skill_list_failed",
    unavailableError: "runner_skill_list_unavailable",
  });
}

async function requestRunnerPiSkillSave(session, body) {
  return requestRunnerJson(session, "/pi/skills", {
    method: "POST",
    body,
    notFoundError: "runner_skill_save_unsupported",
    notFoundStatus: 501,
    failureError: "pi_skill_save_failed",
    unavailableError: "runner_skill_save_unavailable",
    timeoutMs: 30000,
  });
}

async function requestRunnerPiSkillDelete(session, body) {
  return requestRunnerJson(session, "/pi/skills/delete", {
    method: "POST",
    body,
    notFoundError: "runner_skill_delete_unsupported",
    notFoundStatus: 501,
    failureError: "pi_skill_delete_failed",
    unavailableError: "runner_skill_delete_unavailable",
    timeoutMs: 30000,
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
      if (response.status === 404 && options.notFoundError) {
        throw httpError(options.notFoundStatus || 503, options.notFoundError);
      }
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

function parseCpuCount(value) {
  const number = Number.parseFloat(cleanName(value || DEFAULT_CPU));
  return Number.isFinite(number) && number > 0 ? number : Number.parseFloat(DEFAULT_CPU) || 1;
}

function parseMemoryGb(value) {
  const raw = cleanName(value || DEFAULT_MEMORY).toLowerCase();
  const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)(ki|mi|gi|ti|k|m|g|t)?$/);
  if (!match) return parseMemoryGb(DEFAULT_MEMORY) || 1;
  const number = Number.parseFloat(match[1]);
  if (!Number.isFinite(number) || number <= 0) return parseMemoryGb(DEFAULT_MEMORY) || 1;
  const unit = match[2] || "g";
  if (unit === "ki" || unit === "k") return number / (1024 * 1024);
  if (unit === "mi" || unit === "m") return number / 1024;
  if (unit === "ti" || unit === "t") return number * 1024;
  return number;
}

function resourceLimits(resources) {
  return {
    cpu: resources.cpu,
    memory: resources.memory,
  };
}

function isIdleSession(session, now) {
  const idleTimeoutMinutes = Math.min(
      positiveNumber(session.idleTimeoutMinutes, DEFAULT_IDLE_TIMEOUT_MINUTES),
      DEFAULT_IDLE_TIMEOUT_MINUTES,
  );
  const idleSince = latestTimestampMillis(
      session.lastActivityAt,
      session.lastConnectedAt,
      session.lastDisconnectedAt,
      session.updatedAt,
      session.createdAt,
  );
  if (!idleSince) return false;
  return now - idleSince >= idleTimeoutMinutes * 60 * 1000;
}

function latestTimestampMillis(...values) {
  return values.reduce((latest, value) => Math.max(latest, timestampMillis(value)), 0);
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
  if (isHiddenWorkspaceFilePath(relativePath)) {
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

function normalizePiSkillPayload(payload) {
  return {
    name: normalizePiSkillName(payload && payload.name),
    description: normalizePiSkillDescription(payload && payload.description),
    content: normalizePiSkillContent(payload && (payload.content || payload.instructions)),
  };
}

function normalizePiSkillName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw httpError(400, "invalid_skill_name");
  }
  return name;
}

function normalizePiSkillDescription(value) {
  const description = String(value || "").trim();
  if (!description || description.length > 1024 || /[\u0000-\u001f\u007f]/.test(description)) {
    throw httpError(400, "invalid_skill_description");
  }
  return description;
}

function normalizePiSkillContent(value) {
  const content = String(value || "").trim();
  if (!content || content.length > 128 * 1024 || /\u0000/.test(content)) {
    throw httpError(400, "invalid_skill_content");
  }
  return content;
}

function normalizePiPackageSource(value) {
  const source = String(value || "").trim();
  if (!source || /[\u0000-\u001f\u007f]/.test(source)) {
    throw httpError(400, "invalid_package_source");
  }
  if (source.startsWith("npm:")) {
    return normalizeNpmPackageSource(source);
  }
  const gitSource = normalizeGitPackageSource(source);
  if (gitSource) return gitSource;
  throw httpError(400, "unsupported_package_source");
}

function normalizeNpmPackageSource(source) {
  const spec = source.slice("npm:".length).trim();
  const match = spec.match(/^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@([^\s/]+))?$/i);
  if (!match) throw httpError(400, "invalid_package_source");
  const name = match[1].toLowerCase();
  return {
    source,
    type: "npm",
    identity: `npm:${name}`,
    name,
    pinned: Boolean(match[2]),
  };
}

function normalizeGitPackageSource(source) {
  const parsed = parseGitPackageSource(source);
  if (!parsed) return null;
  return {
    source,
    type: "git",
    identity: `git:${parsed.host}/${parsed.path}`,
    host: parsed.host,
    path: parsed.path,
    pinned: Boolean(parsed.ref),
  };
}

function parseGitPackageSource(source) {
  const withoutGitPrefix = source.startsWith("git:") ? source.slice("git:".length) : source;
  const withoutGitPlus = withoutGitPrefix.startsWith("git+") ? withoutGitPrefix.slice("git+".length) : withoutGitPrefix;
  const [withoutRef, ref = ""] = withoutGitPlus.split("#");

  const sshMatch = withoutRef.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) return buildGitPackageSource(sshMatch[1], sshMatch[2], ref);

  const githubShorthand = withoutRef.match(/^github:([^/]+\/.+)$/);
  if (githubShorthand) return buildGitPackageSource("github.com", githubShorthand[1], ref);

  try {
    const parsed = new URL(withoutRef);
    if (parsed.username || parsed.password) throw httpError(400, "package_source_must_not_include_credentials");
    if (["git:", "https:", "ssh:"].includes(parsed.protocol)) {
      return buildGitPackageSource(parsed.hostname, parsed.pathname.replace(/^\/+/, ""), ref || parsed.hash.replace(/^#/, ""));
    }
  } catch (error) {
    if (error && error.status) throw error;
  }

  return null;
}

function buildGitPackageSource(host, gitPath, ref = "") {
  const normalizedHost = String(host || "").trim().toLowerCase();
  const normalizedPath = String(gitPath || "").trim().replace(/\.git$/, "");
  const parts = normalizeStoragePrefix(normalizedPath).split("/").filter(Boolean);
  if (!normalizedHost || !parts.length || parts.some((part) => part === "." || part === "..")) {
    throw httpError(400, "invalid_package_source");
  }
  if (!/^[a-z0-9.-]+$/i.test(normalizedHost)) throw httpError(400, "invalid_package_source");
  return {host: normalizedHost, path: parts.join("/"), ref: String(ref || "").trim()};
}

function piAuthDoc(uid) {
  return db.collection("users").doc(uid).collection("private").doc("piAuth");
}

function normalizePiAuthProviders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.entries(value).reduce((acc, [provider, credential]) => {
    const key = cleanName(provider);
    if (!key || !credential || typeof credential !== "object" || Array.isArray(credential)) return acc;
    acc[key] = normalizePlainObject(credential);
    return acc;
  }, {});
}

function normalizePlainObject(value) {
  return Object.entries(value || {}).reduce((acc, [key, item]) => {
    const cleanKey = cleanName(key);
    if (!cleanKey) return acc;
    const normalized = normalizePlainValue(item);
    if (normalized !== undefined) acc[cleanKey] = normalized;
    return acc;
  }, {});
}

function normalizePlainValue(value) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) {
    return value.map(normalizePlainValue).filter((entry) => entry !== undefined);
  }
  if (value && typeof value === "object") return normalizePlainObject(value);
  return undefined;
}

function normalizePiAuthProviderKey(value) {
  const provider = normalizePiAuthStoredProviderKey(value);
  if (!PI_AUTH_API_KEY_PROVIDERS.has(provider)) {
    throw httpError(400, "invalid_pi_auth_provider");
  }
  return provider;
}

function normalizePiAuthStoredProviderKey(value) {
  const provider = cleanName(value);
  if (!provider || provider.length > 256 || /[\u0000-\u001f\u007f]/.test(provider)) {
    throw httpError(400, "invalid_pi_auth_provider");
  }
  return provider;
}

function normalizePiAuthApiKey(value) {
  const key = String(value || "").trim();
  if (!key || /[\u0000-\u001f\u007f]/.test(key) || key.length > 4096) {
    throw httpError(400, "invalid_pi_auth_key");
  }
  return key;
}

function piPackageCatalogCollection(uid) {
  return db.collection("users").doc(uid).collection("piPackageCatalog");
}

function piPackageCatalogDocId(identity) {
  return encodeURIComponent(identity);
}

function piPackageCatalogRecord(source, workspaceId, options = {}) {
  const normalized = normalizePiPackageSource(source);
  const now = admin.firestore.FieldValue.serverTimestamp();
  return {
    identity: normalized.identity,
    type: normalized.type,
    source: normalized.source,
    updatedAt: now,
    lastWorkspaceId: cleanName(workspaceId || ""),
    installCount: admin.firestore.FieldValue.increment(options.incrementInstallCount ? 1 : 0),
    ...(options.includeCreatedAt ? {createdAt: now, favorite: false} : {}),
  };
}

async function mergePiPackageCatalogEntry(uid, workspaceId, source, options = {}) {
  const record = piPackageCatalogRecord(source, workspaceId, options);
  await piPackageCatalogCollection(uid).doc(piPackageCatalogDocId(record.identity)).set(record, {merge: true});
  return record;
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
  if (isHiddenWorkspaceFilePath(parts.join("/"))) {
    throw httpError(400, "invalid_file_path");
  }
  return parts.join("/");
}

function isHiddenWorkspaceFilePath(relativePath) {
  const parts = String(relativePath || "").split("/").filter(Boolean);
  if (parts[0] === INTERNAL_STORAGE_DIR) return true;
  return parts[0] === ".pi" && (parts[1] === "npm" || parts[1] === "git");
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

function cleanContentType(value) {
  const contentType = String(value || "").trim();
  if (!contentType || /[\r\n\u0000-\u001f\u007f]/.test(contentType)) return "";
  return contentType.slice(0, 255);
}

function workspaceUploadBuffer(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  return Buffer.alloc(0);
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
