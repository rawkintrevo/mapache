"use strict";

const logger = require("firebase-functions/logger");
const {
  admin,
  db,
} = require("./backendContext");
const {
  appAllowListStatus,
  isAppAllowListConfigured,
  isFirebaseTokenAllowed,
} = require("./appAllowList.helpers");
const {
  cleanName,
  httpError,
  toClientDoc,
} = require("./backendUtils.helpers");
const {validateAutomationScheduleTimezone} = require("./automationSchedule.helpers");

const APP_ACCESS_CONFIG_REF = db.collection("appConfig").doc("access");

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
  const appAllowListConfig = await getAppAllowListConfig();
  if (!isFirebaseTokenAllowed(token, appAllowListConfig)) {
    logger.warn("authenticated user rejected by app allow list", {
      uid: token.uid,
      email: token.email || "",
      allowListConfigured: isAppAllowListConfigured(appAllowListConfig),
      allowListEntryCount: appAllowListStatus(appAllowListConfig).entryCount,
    });
    throw httpError(403, "app_access_not_allowed");
  }
  return upsertUser(token);
}

async function getAppAllowListConfig() {
  const snap = await APP_ACCESS_CONFIG_REF.get();
  return snap.exists ? snap.data() : {};
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

async function updateUserTimezone(uid, payload = {}, dependencies = {}) {
  const profileDb = dependencies.db || db;
  const profileAdmin = dependencies.admin || admin;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError(400, "invalid_user_timezone");
  }
  if (Object.keys(payload).some((key) => key !== "timezone")) {
    throw httpError(400, "invalid_user_timezone");
  }
  let timezone;
  try {
    timezone = validateAutomationScheduleTimezone(payload.timezone);
  } catch (error) {
    throw httpError(400, error.code || "invalid_user_timezone", error);
  }
  const ref = profileDb.collection("users").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, "user_not_found");
  await ref.update({
    timezone,
    updatedAt: profileAdmin.firestore.FieldValue.serverTimestamp(),
  });
  return toClientDoc(await ref.get());
}

function providerIdsFromToken(token) {
  const firebase = token.firebase || {};
  const ids = Object.keys(firebase.identities || {}).filter((id) => id !== "email");
  if (firebase.sign_in_provider && !ids.includes(firebase.sign_in_provider)) {
    ids.unshift(firebase.sign_in_provider);
  }
  return ids;
}

module.exports = {
  getAppAllowListConfig,
  providerIdsFromToken,
  requireUser,
  updateUserTimezone,
  upsertUser,
};
