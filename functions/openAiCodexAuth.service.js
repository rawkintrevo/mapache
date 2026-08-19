"use strict";

const {OPENAI_CODEX_PROVIDER} = require("./apiRoutes.helpers");
const {httpError} = require("./backendUtils.helpers");

const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_DEVICE_USER_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const OPENAI_CODEX_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const OPENAI_CODEX_DEVICE_VERIFICATION_URI = "https://auth.openai.com/codex/device";
const OPENAI_CODEX_DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const OPENAI_CODEX_ACCOUNT_CLAIM_PATH = "https://api.openai.com/auth";

function createOpenAiCodexAuthService(dependencies = {}) {
  return {
    startOpenAiCodexDeviceCode,
    completeOpenAiCodexDeviceCode: (uid, payload) => completeOpenAiCodexDeviceCode(uid, payload, dependencies),
  };
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

async function completeOpenAiCodexDeviceCode(uid, payload, dependencies = {}) {
  const deviceAuthId = cleanOpenAiCodexDeviceField(payload && payload.deviceAuthId);
  const userCode = cleanOpenAiCodexDeviceField(payload && payload.userCode);
  if (!deviceAuthId || !userCode) throw httpError(400, "invalid_openai_codex_device_code");

  const tokenResponse = await fetch(OPENAI_CODEX_DEVICE_TOKEN_URL, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({device_auth_id: deviceAuthId, user_code: userCode}),
  });

  if (!tokenResponse.ok) {
    if (tokenResponse.status === 403 || tokenResponse.status === 404) return {status: "pending"};
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
  if (!dependencies.agentAuthService) throw new Error("OpenAI Codex auth requires an agentAuthService dependency.");
  await dependencies.agentAuthService.savePiAuthCredential(uid, OPENAI_CODEX_PROVIDER, {type: "oauth", ...oauth});
  return {status: "complete", ...(await dependencies.agentAuthService.getPiAuth(uid))};
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
    id: data.id_token || "",
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
    accountId,
  };
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

module.exports = {
  cleanOpenAiCodexDeviceField,
  createOpenAiCodexAuthService,
  openAiCodexAccountId,
  parseOpenAiCodexErrorCode,
};
