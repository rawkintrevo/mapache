"use strict";

const crypto = require("crypto");
const {admin} = require("./backendContext");
const {
  QA_LOGIN_DISPLAY_NAME,
  QA_LOGIN_EMAIL,
  QA_LOGIN_SECRET,
  QA_LOGIN_UID,
} = require("./backendConfig");
const {
  cleanName,
  httpError,
} = require("./backendUtils.helpers");

function createQaAuthService(dependencies = {}) {
  const auth = dependencies.auth || admin.auth();
  return {
    mintQaCustomToken: (req) => mintQaCustomToken(req, auth, dependencies),
  };
}

async function mintQaCustomToken(req, auth, options = {}) {
  const expectedSecret = qaLoginSecret(options);
  const uid = qaLoginUid(options);
  const email = qaLoginEmail(options);
  const displayName = qaLoginDisplayName(options);

  if (!expectedSecret || !uid || !email) {
    throw httpError(503, "qa_login_not_configured");
  }
  if (!secretsMatch(requestSecret(req), expectedSecret)) {
    throw httpError(403, "qa_login_denied");
  }

  await ensureQaUser(auth, {uid, email, displayName});
  const token = await auth.createCustomToken(uid, {
    qa: true,
    qaEmail: email,
  });
  return {
    token,
    uid,
    email,
  };
}

async function ensureQaUser(auth, profile) {
  try {
    await auth.updateUser(profile.uid, {
      email: profile.email,
      displayName: profile.displayName,
      disabled: false,
    });
  } catch (error) {
    if (error && error.code === "auth/user-not-found") {
      await auth.createUser({
        uid: profile.uid,
        email: profile.email,
        displayName: profile.displayName,
        emailVerified: true,
        disabled: false,
      });
      return;
    }
    throw httpError(502, "qa_login_user_update_failed", error);
  }
}

function requestSecret(req) {
  const headerValue = req && typeof req.get === "function" ?
    req.get("x-mapache-qa-secret") :
    "";
  return cleanName(headerValue || (req && req.body && req.body.secret) || "");
}

function secretsMatch(received, expected) {
  const receivedBuffer = Buffer.from(String(received || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));
  if (!receivedBuffer.length || receivedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

function qaLoginSecret(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "secret")) return cleanName(options.secret);
  return cleanName(secretValue(QA_LOGIN_SECRET) || process.env.QA_LOGIN_SECRET || "");
}

function qaLoginUid(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "uid")) return cleanName(options.uid);
  return cleanName(paramValue(QA_LOGIN_UID) || process.env.QA_LOGIN_UID || "");
}

function qaLoginEmail(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "email")) return cleanName(options.email);
  return cleanName(paramValue(QA_LOGIN_EMAIL) || process.env.QA_LOGIN_EMAIL || "");
}

function qaLoginDisplayName(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "displayName")) {
    return cleanName(options.displayName || "Mapache QA Agent");
  }
  return cleanName(paramValue(QA_LOGIN_DISPLAY_NAME) || process.env.QA_LOGIN_DISPLAY_NAME || "Mapache QA Agent");
}

function paramValue(param) {
  try {
    return param.value();
  } catch (error) {
    return "";
  }
}

function secretValue(secret) {
  try {
    return secret.value();
  } catch (error) {
    return "";
  }
}

module.exports = {
  createQaAuthService,
  ensureQaUser,
  mintQaCustomToken,
  requestSecret,
  secretsMatch,
};
