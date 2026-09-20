"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const DEFAULT_TOKEN_REFRESH_LEEWAY_SECONDS = 30;
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Private runner-side adapter for the workspace-scoped automation API.
 *
 * The signing key and shutdown credential stay in this process. The child
 * Pi/MCP process receives only the path to the 0600 Unix socket, and requests
 * made through that socket are authenticated and refreshed here in memory.
 */
function createAutomationAgentApiService(config = {}, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  const httpImpl = dependencies.http || http;
  const fetchImpl = dependencies.fetch || global.fetch;
  const now = dependencies.now || (() => Date.now());
  const tokenRefreshLeewaySeconds = Number(dependencies.tokenRefreshLeewaySeconds || DEFAULT_TOKEN_REFRESH_LEEWAY_SECONDS);
  const socketPath = String(config.automationAgentSocketPath || "").trim();
  let cachedToken = "";
  let cachedTokenExpiresAt = 0;
  let server = null;
  let startPromise = null;

  return {
    call,
    socketPath,
    start,
    stop,
    status: () => ({enabled: Boolean(socketPath), listening: Boolean(server)}),
  };

  async function start() {
    if (!socketPath) return {enabled: false, skipped: true};
    if (server) return {enabled: true, listening: true};
    if (startPromise) return startPromise;
    startPromise = startInternal();
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  async function startInternal() {
    await fsImpl.promises.mkdir(path.dirname(socketPath), {recursive: true, mode: 0o700});
    await fsImpl.promises.unlink(socketPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    server = httpImpl.createServer((request, response) => {
      void handleLocalRequest(request, response);
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server?.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server?.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(socketPath);
    });
    await fsImpl.promises.chmod(socketPath, 0o600);
    return {enabled: true, listening: true};
  }

  async function stop() {
    cachedToken = "";
    cachedTokenExpiresAt = 0;
    const current = server;
    server = null;
    if (current) {
      await new Promise((resolve) => current.close(() => resolve()));
    }
    if (socketPath) await fsImpl.promises.unlink(socketPath).catch(() => {});
    return {enabled: Boolean(socketPath), listening: false};
  }

  async function call(pathname, options = {}) {
    return callRemote(pathname, options, true);
  }

  async function callRemote(pathname, options, retryAfterUnauthorized) {
    const token = await getToken();
    const url = remoteUrl(pathname, config.automationAgentApiUrl);
    if (!url) throw adapterError("automation_agent_unavailable");
    const headers = {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : {"content-type": "application/json"}),
    };
    const response = await fetchImpl(url, {
      method: String(options.method || "GET").toUpperCase(),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "manual",
    });
    const body = await parseResponse(response);
    if (response.ok) return body;
    if (response.status === 401 && retryAfterUnauthorized) {
      cachedToken = "";
      cachedTokenExpiresAt = 0;
      return callRemote(pathname, options, false);
    }
    const error = adapterError(response.status === 401 ? "automation_agent_unauthorized" : "automation_agent_request_failed");
    error.status = response.status || 502;
    error.body = body;
    throw error;
  }

  async function getToken() {
    const nowSeconds = Math.floor(Number(now()) / 1000);
    if (cachedToken && cachedTokenExpiresAt > nowSeconds + tokenRefreshLeewaySeconds) return cachedToken;
    if (!config.automationAgentTokenUrl || !config.shutdownToken) throw adapterError("automation_agent_unavailable");
    const response = await fetchImpl(config.automationAgentTokenUrl, {
      method: "POST",
      headers: {"content-type": "application/json", "x-shutdown-token": config.shutdownToken},
      body: JSON.stringify({workspaceId: config.workspaceId, sessionId: config.sessionId}),
      redirect: "manual",
    });
    const body = await parseResponse(response);
    if (!response.ok || !body?.accessToken) throw adapterError("automation_agent_token_unavailable");
    const expiry = tokenExpiry(body.accessToken);
    if (!expiry) throw adapterError("automation_agent_token_unavailable");
    cachedToken = String(body.accessToken);
    cachedTokenExpiresAt = expiry;
    return cachedToken;
  }

  async function handleLocalRequest(request, response) {
    try {
      const pathname = String(request.url || "");
      if (!/^\/api\/agent\/(automations|automation-settings|automation-runs|automation-schedule-preview)(?:[/?]|$)/.test(pathname)) {
        writeJson(response, 404, {error: "not_found"});
        return;
      }
      const body = await readBody(request);
      const result = await callRemote(pathname, {
        method: request.method,
        headers: request.headers?.["idempotency-key"] ? {"idempotency-key": request.headers["idempotency-key"]} : {},
        ...(body === undefined ? {} : {body}),
      }, true);
      writeJson(response, 200, result);
    } catch (error) {
      writeJson(response, error.status || 502, error.body || {error: error.publicMessage || "automation_agent_request_failed"});
    }
  }
}

async function parseResponse(response) {
  try {
    return await response.json();
  } catch {
    return {error: "automation_agent_request_failed"};
  }
}

async function readBody(request) {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(String(request.method || "").toUpperCase())) return undefined;
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw adapterError("request_too_large", 413);
    chunks.push(chunk);
  }
  if (!total) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw adapterError("invalid_request", 400, error);
  }
}

function remoteUrl(pathname, base) {
  const cleanBase = String(base || "").replace(/\/$/, "");
  const cleanPath = String(pathname || "");
  if (!cleanBase || !cleanPath.startsWith("/api/agent/")) return "";
  return `${cleanBase}${cleanPath}`;
}

function tokenExpiry(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length !== 3) return 0;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return Number.isSafeInteger(claims.exp) ? claims.exp : 0;
  } catch {
    return 0;
  }
}

function writeJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function adapterError(publicMessage, status = 502, cause) {
  const error = new Error(publicMessage);
  error.publicMessage = publicMessage;
  error.status = status;
  if (cause) error.cause = cause;
  return error;
}

module.exports = {
  DEFAULT_TOKEN_REFRESH_LEEWAY_SECONDS,
  createAutomationAgentApiService,
  remoteUrl,
  tokenExpiry,
};
