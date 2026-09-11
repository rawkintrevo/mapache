"use strict";

const fs = require("fs");
const path = require("path");
const {randomBytes} = require("node:crypto");
const {spawn: defaultSpawn} = require("node:child_process");
const {createWorkspaceProcessEnvironment} = require("./runnerEnvironment");

const DEFAULT_HEALTH_INTERVAL_MS = 100;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

/**
 * Owns the one embedded pi-web-ui process for a marked runner.
 *
 * This adapter intentionally has no restart loop. A process that fails after
 * becoming ready is reported to the existing runner activity writer and the
 * session remains failed until the control plane recreates it. The upstream
 * token is generated here and only placed in the child environment and local
 * health request; it is never returned in status or sent to the logger.
 */
function createPiWebUiProcess(config = {}, deps = {}) {
  const enabled = config.agentRuntimeEnabled === true || config.agentUiVersion === "pi-web-ui-v1";
  const fsImpl = deps.fs || fs;
  const spawnImpl = deps.spawn || defaultSpawn;
  const fetchImpl = deps.fetch || global.fetch;
  const randomBytesImpl = deps.randomBytes || randomBytes;
  const environment = deps.env || process.env;
  const now = deps.now || (() => Date.now());
  const setTimeoutImpl = deps.setTimeout || setTimeout;
  const clearTimeoutImpl = deps.clearTimeout || clearTimeout;
  const delayImpl = deps.delay || ((delayMs) => new Promise((resolve) => setTimeoutImpl(resolve, delayMs)));
  const logger = deps.logger || console;
  const onExit = deps.onExit;
  const listeners = new Set();
  const exitWaiters = new Map();
  const healthIntervalMs = positiveNumber(config.piWebUiHealthIntervalMs, DEFAULT_HEALTH_INTERVAL_MS);
  const startupTimeoutMs = positiveNumber(config.piWebUiStartupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
  const stopTimeoutMs = positiveNumber(config.piWebUiStopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS);
  let state = enabled ? "stopped" : "disabled";
  let child = null;
  let privateToken = "";
  let lastError = "";
  let lastHealth = null;
  let startPromise = null;
  let stopping = false;
  let readyOnce = false;

  return {
    enabled: () => enabled,
    start,
    health,
    upstreamHeaders() {
      return privateToken ? {"x-pi-token": privateToken} : {};
    },
    stop,
    status,
    onStateChange(listener) {
      if (typeof listener !== "function") throw new TypeError("pi-web-ui state listener must be a function");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  async function start() {
    if (!enabled) return status();
    if (state === "ready") return status();
    if (startPromise) return startPromise;
    if (state === "error") throw publicError(lastError || "pi_web_ui_start_failed");

    stopping = false;
    lastError = "";
    lastHealth = null;
    setState("starting");
    startPromise = startInternal();
    try {
      return await startPromise;
    } catch (cause) {
      const failure = toPublicError(cause);
      if (child) await terminateChild(child, Math.min(stopTimeoutMs, 1000)).catch(() => {});
      state = stopping ? "stopped" : "error";
      lastError = stopping ? "" : failure.message;
      notifyStateChange();
      throw failure;
    } finally {
      startPromise = null;
    }
  }

  async function startInternal() {
    const root = String(config.piWebUiRoot || "").trim();
    const entry = path.join(root, "dist", "server", "index.js");
    if (!root || !await pathExists(entry)) throw publicError("pi_web_ui_runtime_missing");
    const adapterPath = String(config.piMcpAdapterPath || environment.PI_WEB_MCP_ADAPTER_PATH || "").trim();
    const adapterCheck = validatePiMcpAdapter(fsImpl, adapterPath, config.piMcpAdapterVersion || "2.32.1");
    if (adapterCheck !== "ok") throw publicError(adapterCheck);

    await fsImpl.promises.mkdir(config.piWebUiDataDir, {recursive: true, mode: 0o700});
    await fsImpl.promises.mkdir(config.piWebUiPiDir, {recursive: true, mode: 0o700});
    await fsImpl.promises.mkdir(config.piWebUiSessionDir, {recursive: true, mode: 0o700});
    if (stopping) throw publicError("pi_web_ui_start_cancelled");

    privateToken = makePrivateToken(randomBytesImpl);
    let next;
    try {
      next = spawnImpl(process.execPath, [entry], {
        cwd: config.workspaceDir,
        env: childEnvironment(privateToken),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      privateToken = "";
      throw publicError("pi_web_ui_spawn_failed", cause);
    }
    child = next;
    consumeOutput(next.stdout);
    consumeOutput(next.stderr);
    if (typeof next.once === "function") {
      next.once("error", (error) => handleChildExit(next, null, null, error));
      next.once("exit", (code, signal) => handleChildExit(next, code, signal));
    }

    await waitForHealthy();
    if (stopping || child !== next) throw publicError("pi_web_ui_start_cancelled");
    readyOnce = true;
    setState("ready");
    return status();
  }

  async function health() {
    if (!enabled) return status();
    if (!child || !privateToken) return {...status(), ready: false};
    const url = `http://${config.piWebUiHost || "127.0.0.1"}:${config.piWebUiPort || 8787}/api/health`;
    if (typeof fetchImpl !== "function") {
      return {...status(), ready: false, error: "pi_web_ui_health_unavailable"};
    }
    try {
      const response = await fetchImpl(url, {
        headers: {"x-pi-token": privateToken},
        redirect: "manual",
      });
      if (!response || !response.ok) {
        const error = `pi_web_ui_health_http_${response?.status || "unavailable"}`;
        lastHealth = {ready: false, error};
        return {...status(), ready: false, error};
      }
      const body = await response.json();
      if (!body || body.ok !== true || body.engine !== "pi") {
        const error = body?.engine && body.engine !== "pi" ? "pi_web_ui_wrong_engine" : "pi_web_ui_health_invalid";
        lastHealth = {ready: false, error};
        return {...status(), ready: false, error};
      }
      lastHealth = {ready: true, engine: "pi", build: safeBuildDescriptor(body.build)};
      return {...status(), ready: true, engine: "pi", build: lastHealth.build};
    } catch (cause) {
      const error = "pi_web_ui_health_unavailable";
      lastHealth = {ready: false, error};
      return {...status(), ready: false, error};
    }
  }

  async function waitForHealthy() {
    const deadline = now() + startupTimeoutMs;
    const maxAttempts = Math.max(1, Math.ceil(startupTimeoutMs / Math.max(1, healthIntervalMs)) + 1);
    let attempts = 0;
    while (now() <= deadline && attempts < maxAttempts) {
      attempts += 1;
      if (!child || state === "error") throw publicError(lastError || "pi_web_ui_process_exited");
      if (stopping) throw publicError("pi_web_ui_start_cancelled");
      const result = await health();
      if (result.ready) return result;
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await delayImpl(Math.min(healthIntervalMs, remaining));
    }
    throw publicError("pi_web_ui_health_timeout");
  }

  async function stop() {
    if (!enabled) return status();
    stopping = true;
    const current = child;
    const pendingStart = startPromise;
    if (!current) {
      if (pendingStart) await pendingStart.catch(() => {});
      if (state !== "error") setState("stopped");
      stopping = false;
      return status();
    }
    setState("stopping");
    try {
      await terminateChild(current, stopTimeoutMs);
      if (pendingStart) await pendingStart.catch(() => {});
      if (child === current) throw publicError("pi_web_ui_stop_timeout");
      setState("stopped");
      return status();
    } catch (cause) {
      const failure = toPublicError(cause, "pi_web_ui_stop_failed");
      state = "error";
      lastError = failure.message;
      notifyStateChange();
      throw failure;
    } finally {
      stopping = false;
      privateToken = "";
    }
  }

  async function terminateChild(current, timeoutMs) {
    try {
      current.kill?.("SIGTERM");
    } catch (cause) {
      throw publicError("pi_web_ui_stop_failed", cause);
    }
    if (await waitForExit(current, timeoutMs)) return;
    try {
      current.kill?.("SIGKILL");
    } catch (cause) {
      throw publicError("pi_web_ui_stop_failed", cause);
    }
    if (!await waitForExit(current, timeoutMs)) throw publicError("pi_web_ui_stop_timeout");
  }

  function handleChildExit(current, code, signal, cause) {
    if (child !== current) return;
    child = null;
    privateToken = "";
    resolveExitWaiters(current);
    if (stopping) {
      state = "stopped";
      lastError = "";
      notifyStateChange();
      return;
    }
    state = "error";
    lastError = cause ? "pi_web_ui_process_error" : "pi_web_ui_process_exited";
    notifyStateChange();
    const exitError = publicError(lastError);
    if (readyOnce && typeof onExit === "function") {
      Promise.resolve(onExit({code, signal, error: exitError})).catch((error) => {
        logger.error?.("pi-web-ui exit report failed", sanitizeError(error));
      });
    }
  }

  function waitForExit(current, timeoutMs) {
    if (child !== current) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeoutImpl(() => {
        const waiters = exitWaiters.get(current);
        waiters?.delete(waiter);
        if (waiters && waiters.size === 0) exitWaiters.delete(current);
        resolve(false);
      }, Math.max(1, timeoutMs));
      const waiter = {resolve: () => {
        clearTimeoutImpl(timer);
        resolve(true);
      }};
      let waiters = exitWaiters.get(current);
      if (!waiters) {
        waiters = new Set();
        exitWaiters.set(current, waiters);
      }
      waiters.add(waiter);
    });
  }

  function resolveExitWaiters(current) {
    const waiters = exitWaiters.get(current);
    if (!waiters) return;
    exitWaiters.delete(current);
    for (const waiter of waiters) waiter.resolve();
  }

  function childEnvironment(token) {
    return {
      ...createWorkspaceProcessEnvironment(config, environment),
      HOME: config.homeDir || environment.HOME || "/root",
      PI_CODING_AGENT_DIR: config.piWebUiPiDir,
      PI_CODING_AGENT_SESSION_DIR: config.piWebUiSessionDir,
      PI_WEB_CWD: config.workspaceDir,
      PI_WEB_DATA_DIR: config.piWebUiDataDir,
      PI_WEB_ENGINE: "pi",
      PI_WEB_HOST: config.piWebUiHost || "127.0.0.1",
      PI_WEB_MANAGED: "1",
      PI_WEB_MCP_ADAPTER_PATH: config.piMcpAdapterPath || environment.PI_WEB_MCP_ADAPTER_PATH || "",
      PI_WEB_PKG_ROOT: config.piWebUiRoot,
      PI_WEB_PORT: String(config.piWebUiPort || 8787),
      PI_WEB_TOKEN: token,
    };
  }

  function status() {
    return {
      enabled,
      state,
      ready: state === "ready" && Boolean(child),
      host: enabled ? config.piWebUiHost || "127.0.0.1" : null,
      port: enabled ? config.piWebUiPort || 8787 : null,
      pid: child?.pid || null,
      error: lastError || null,
      health: lastHealth ? {...lastHealth} : null,
    };
  }

  function setState(next) {
    state = next;
    notifyStateChange();
  }

  function notifyStateChange() {
    const snapshot = status();
    for (const listener of listeners) listener(snapshot);
  }

  async function pathExists(target) {
    try {
      await fsImpl.promises.access(target);
      return true;
    } catch (error) {
      return false;
    }
  }
}

function makePrivateToken(randomBytesImpl) {
  const value = randomBytesImpl(32);
  return Buffer.from(value).toString("base64url");
}

function consumeOutput(stream) {
  stream?.on?.("data", () => {});
  stream?.on?.("error", () => {});
}

function safeBuildDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const key of ["upstreamCommit", "packageVersion", "piSdkVersion", "piMcpAdapterVersion"]) {
    if (typeof value[key] === "string" && value[key]) result[key] = value[key];
  }
  return Object.keys(result).length ? result : null;
}

function validatePiMcpAdapter(fsImpl, adapterPath, expectedVersion) {
  if (!adapterPath) return "pi_mcp_adapter_missing";
  const packageRoot = path.dirname(adapterPath);
  try {
    const packageJson = JSON.parse(fsImpl.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (packageJson.name !== "pi-mcp-adapter" || packageJson.version !== expectedVersion || !packageJson.pi?.extensions?.includes("./index.ts")) return "pi_mcp_adapter_incompatible";
    if (!fsImpl.statSync(adapterPath).isFile()) return "pi_mcp_adapter_incompatible";
    return "ok";
  } catch (error) {
    return error?.code === "ENOENT" ? "pi_mcp_adapter_missing" : "pi_mcp_adapter_incompatible";
  }
}

function positiveNumber(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : fallback;
}

function publicError(code) {
  const error = new Error(String(code || "pi_web_ui_failed"));
  error.code = error.message;
  error.publicMessage = error.message;
  return error;
}

function toPublicError(error, fallback = "pi_web_ui_failed") {
  if (error?.publicMessage && /^pi_(?:web_ui|mcp_adapter)_[a-z0-9_]+$/.test(error.publicMessage)) return error;
  if (error?.code && /^pi_(?:web_ui|mcp_adapter)_[a-z0-9_]+$/.test(error.code)) return publicError(error.code);
  return publicError(fallback);
}

function sanitizeError(error) {
  return String(error?.message || error || "unknown_error").replace(/\s+/g, " ").slice(0, 240);
}

module.exports = {
  createPiWebUiProcess,
  makePrivateToken,
  safeBuildDescriptor,
  validatePiMcpAdapter,
};
