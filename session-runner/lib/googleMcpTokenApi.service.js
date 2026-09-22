"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const {ensurePrivateRuntimeDirectory} = require("./runtimeStorage.helpers");

const TOKEN_PATH = "/google/token";
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Keeps the Google token broker credential in the runner process. The managed
 * Pi/MCP child receives only this socket path and never receives the shutdown
 * credential or the broker URL.
 */
function createGoogleMcpTokenApiService(config = {}, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  const httpImpl = dependencies.http || http;
  const fetchImpl = dependencies.fetch || global.fetch;
  const socketPath = String(config.googleMcpTokenSocketPath || "").trim();
  const refreshUrl = String(config.googleMcpTokenRefreshUrl || "").trim();
  const connectionId = String(config.googleMcpConnectionId || "").trim();
  const enabled = Boolean(socketPath && refreshUrl && connectionId && config.workspaceId && config.sessionId && config.shutdownToken);
  let server = null;
  let startPromise = null;

  return {enabled: () => enabled, start, stop, status: () => ({enabled, listening: Boolean(server)})};

  async function start() {
    if (!enabled) return {enabled: false, skipped: true};
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
    await ensurePrivateRuntimeDirectory(path.dirname(socketPath), {fsImpl});
    await fsImpl.promises.unlink(socketPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    server = httpImpl.createServer((request, response) => {
      void handleRequest(request, response);
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
    const current = server;
    server = null;
    if (current) await new Promise((resolve) => current.close(() => resolve()));
    if (socketPath) await fsImpl.promises.unlink(socketPath).catch(() => {});
    return {enabled, listening: false};
  }

  async function handleRequest(request, response) {
    response.setHeader("cache-control", "no-store");
    if (request.method !== "POST" || request.url !== TOKEN_PATH) {
      writeJson(response, request.method === "POST" ? 404 : 405, {error: "not_found"});
      request.resume();
      return;
    }
    try {
      await readBody(request);
      const result = await refresh();
      writeJson(response, 200, result);
    } catch (error) {
      const status = boundedStatus(error?.status || 502);
      writeJson(response, status, {error: safeErrorCode(error)});
    }
  }

  async function refresh() {
    if (typeof fetchImpl !== "function") throw serviceError("google_token_refresh_unavailable", 503);
    const response = await fetchImpl(refreshUrl, {
      method: "POST",
      headers: {"content-type": "application/json", "x-shutdown-token": config.shutdownToken},
      body: JSON.stringify({
        workspaceId: config.workspaceId,
        sessionId: config.sessionId,
        connectionId,
      }),
      redirect: "manual",
    });
    const body = await parseResponse(response);
    if (!response.ok) {
      const error = serviceError(body?.error || "google_token_refresh_failed", response.status);
      throw error;
    }
    const accessToken = String(body?.accessToken || "").trim();
    if (!accessToken) throw serviceError("google_access_token_missing", 502);
    return {accessToken, expiresIn: Math.max(0, Number(body.expiresIn || 0))};
  }

  async function parseResponse(response) {
    let text = "";
    for await (const chunk of response.body || []) {
      text += Buffer.from(chunk).toString("utf8");
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw serviceError("google_token_refresh_response_too_large", 502);
    }
    if (!text && typeof response.text === "function") text = await response.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw serviceError("google_token_refresh_invalid_response", 502);
    }
  }

  function serviceError(code, status) {
    const error = new Error(String(code));
    error.code = String(code);
    error.status = status;
    return error;
  }

  function safeErrorCode(error) {
    const code = String(error?.code || error?.publicMessage || "google_token_refresh_failed");
    return /^google_[a-z0-9_]{1,100}$/.test(code) ? code : "google_token_refresh_failed";
  }

  function writeJson(response, status, body) {
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
  }

  function readBody(request) {
    return new Promise((resolve, reject) => {
      let size = 0;
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) {
          request.destroy();
          reject(serviceError("google_token_request_too_large", 413));
        }
      });
      request.on("end", resolve);
      request.on("error", reject);
    });
  }
}

function boundedStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

module.exports = {createGoogleMcpTokenApiService, TOKEN_PATH};
