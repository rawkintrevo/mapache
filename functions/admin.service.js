"use strict";

const {
  admin,
  db,
} = require("./backendContext");
const {
  isUserWhitelisted,
  setUserWhitelistStatus,
} = require("./appAllowList.helpers");
const {
  cleanName,
  httpError,
  toClientDoc,
} = require("./backendUtils.helpers");
const {getUserSessionUsage} = require("./userUsage.service");

const APP_ACCESS_CONFIG_REF = db.collection("appConfig").doc("access");
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;

async function listAdminUsers(currentUser, query = {}) {
  requireAdmin(currentUser);
  const pageSize = normalizePageSize(query.pageSize);
  const cursor = cleanName(query.cursor || "");
  const accessConfig = await getAppAccessConfig();
  let ref = db.collection("users")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(pageSize + 1);
  if (cursor) {
    ref = ref.startAfter(cursor);
  }

  const snap = await ref.get();
  const docs = snap.docs.slice(0, pageSize);
  const users = await Promise.all(docs.map((doc) => adminUserSummary(doc, accessConfig)));
  const overflowDoc = snap.docs[pageSize] || null;

  return {
    users,
    pageSize,
    nextCursor: overflowDoc ? docs[docs.length - 1].id : "",
    allowList: {
      enabled: accessConfig.enabled === true,
    },
  };
}

async function setAdminUserWhitelist(currentUser, targetUid, whitelisted) {
  requireAdmin(currentUser);
  const uid = cleanName(targetUid);
  if (!uid) throw httpError(400, "missing_user_id");
  const targetRef = db.collection("users").doc(uid);

  await db.runTransaction(async (transaction) => {
    const targetSnap = await transaction.get(targetRef);
    if (!targetSnap.exists) throw httpError(404, "user_not_found");
    const accessSnap = await transaction.get(APP_ACCESS_CONFIG_REF);
    const accessConfig = accessSnap.exists ? accessSnap.data() : {};
    const nextConfig = setUserWhitelistStatus(
        accessConfig,
        {uid, ...targetSnap.data()},
        whitelisted === true,
    );
    transaction.set(APP_ACCESS_CONFIG_REF, nextConfig, {merge: true});
  });

  const accessConfig = await getAppAccessConfig();
  return adminUserSummary(await targetRef.get(), accessConfig);
}

async function adminUserSummary(doc, accessConfig) {
  const user = toClientDoc(doc);
  const usage = await getUserSessionUsage(user.uid || doc.id);
  return {
    uid: user.uid || doc.id,
    email: cleanName(user.email || ""),
    displayName: cleanName(user.displayName || ""),
    photoURL: cleanName(user.photoURL || ""),
    isAdmin: user.isAdmin === true,
    whitelisted: isUserWhitelisted({...user, uid: user.uid || doc.id}, accessConfig),
    userType: cleanName(user.userType || ""),
    usage,
    costs: {
      lifetimeUsd: estimatedUsageCostUsd(usage.lifetime),
      last30DaysUsd: estimatedUsageCostUsd(usage.last30Days),
    },
    createdAt: user.createdAt || "",
    lastSignedInAt: user.lastSignedInAt || "",
  };
}

async function getAppAccessConfig() {
  const snap = await APP_ACCESS_CONFIG_REF.get();
  return snap.exists ? snap.data() : {};
}

function requireAdmin(user) {
  if (!user || user.isAdmin !== true) {
    throw httpError(403, "admin_required");
  }
}

function normalizePageSize(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, number);
}

function estimatedUsageCostUsd(usage) {
  const cpuSeconds = Number(usage && usage.cpuSeconds || 0);
  const memoryGbSeconds = Number(usage && usage.memoryGbSeconds || 0);
  return Number(((cpuSeconds * 0.000018) + (memoryGbSeconds * 0.000002)).toFixed(6));
}

module.exports = {
  adminUserSummary,
  estimatedUsageCostUsd,
  listAdminUsers,
  normalizePageSize,
  requireAdmin,
  setAdminUserWhitelist,
};
