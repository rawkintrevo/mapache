"use strict";

const fs = require("fs");
const path = require("path");
const {spawn} = require("child_process");

const PROFILE_LOCKS = ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"];
const PROCESS_NAMES = ["vnc", "chromium", "taskbar", "windowManager", "xvfb"];
const REQUIRED_PROCESS_NAMES = ["xvfb", "windowManager", "taskbar", "chromium", "vnc"];

function createChromeDesktopService(config = {}, deps = {}) {
  const enabled = Boolean(config.chromeEnabled || config.runnerCapabilities?.chrome);
  const spawnImpl = deps.spawn || spawn;
  const fsImpl = deps.fs || fs;
  const displayReadyImpl = deps.displayReady || (() => isDisplayReady(fsImpl, config));
  const delayImpl = deps.delay || delay;
  const now = deps.now || (() => Date.now());
  const setTimeoutImpl = deps.setTimeout || setTimeout;
  const clearTimeoutImpl = deps.clearTimeout || clearTimeout;
  const processes = new Map();
  const restartTimers = new Map();
  const restartAttempts = new Map(PROCESS_NAMES.map((name) => [name, 0]));
  const errors = new Map();
  const listeners = new Set();
  const maxRestartAttempts = Math.max(0, Number(config.chromeDesktopRestartMaxAttempts ?? 3));
  const restartBackoffMs = Math.max(1, Number(config.chromeDesktopRestartBackoffMs ?? 250));
  let state = enabled ? "stopped" : "disabled";
  let stopping = false;
  let browserRestartAttempts = 0;
  let startupPromise = null;

  return {
    start,
    stop,
    status,
    onStateChange,
    cleanupStaleLocks: () => cleanupStaleLocks(fsImpl, config),
  };

  async function start() {
    if (!enabled) return status();
    if (state === "running") return status();
    if (state === "starting" && startupPromise) return startupPromise;

    stopping = false;
    state = "starting";
    browserRestartAttempts = 0;
    errors.clear();
    for (const name of PROCESS_NAMES) restartAttempts.set(name, 0);
    notifyStateChange();

    startupPromise = (async () => {
      await fsImpl.promises.mkdir(config.chromeProfileDir, {recursive: true, mode: 0o700});
      await cleanupStaleLocks(fsImpl, config);

      startProcess("xvfb", "Xvfb", [
        config.chromeDisplay,
        "-screen", "0", `${config.chromeViewport.width}x${config.chromeViewport.height}x24`,
        "-ac", "-nolisten", "tcp",
      ], {DISPLAY: config.chromeDisplay});
      await waitForDisplayReady();
      if (stopping) throw new Error("Chrome desktop shutdown requested during startup");
      if (state === "failed") throw new Error("X display process supervision failed");

      startProcess("windowManager", "openbox", [], {DISPLAY: config.chromeDisplay});
      startProcess("taskbar", "tint2", [], {DISPLAY: config.chromeDisplay});
      startChromium();
      startProcess("vnc", "x11vnc", [
        "-display", config.chromeDisplay,
        "-localhost",
        "-rfbport", String(config.chromeVncPort),
        "-forever",
        "-shared",
        "-nopw",
      ], {DISPLAY: config.chromeDisplay});
      if (state === "failed" || !allRequiredProcessesRunning()) {
        throw new Error("Chrome desktop process supervision failed during startup");
      }
      setState("running");
      return status();
    })();

    try {
      return await startupPromise;
    } catch (cause) {
      setState("failed");
      const startupError = new Error(sanitizeDesktopError(cause));
      startupError.publicMessage = startupError.message;
      throw startupError;
    } finally {
      startupPromise = null;
    }
  }

  async function waitForDisplayReady() {
    const timeoutMs = Math.max(1, Number(config.chromeStartupTimeoutMs || 30000));
    const deadline = now() + timeoutMs;
    let lastError = null;
    while (now() <= deadline) {
      if (!processes.has("xvfb")) {
        throw new Error("X display process exited before becoming ready");
      }
      try {
        if (await displayReadyImpl()) return;
      } catch (cause) {
        lastError = cause;
      }
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await delayImpl(Math.min(100, remaining));
    }
    throw new Error(`X display did not become ready: ${sanitizeDesktopError(lastError)}`);
  }

  function startChromium() {
    const args = [
      `--user-data-dir=${config.chromeProfileDir}`,
      `--display=${config.chromeDisplay}`,
      `--remote-debugging-address=${config.chromeCdpHost}`,
      `--remote-debugging-port=${config.chromeCdpPort}`,
      `--window-size=${config.chromeViewport.width},${config.chromeViewport.height}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "about:blank",
    ];
    startProcess("chromium", "chromium", args, {
      DISPLAY: config.chromeDisplay,
      CHROME_USER_DATA_DIR: config.chromeProfileDir,
    });
  }

  function startProcess(name, command, args, extraEnv = {}) {
    let child;
    try {
      child = spawnImpl(command, args, {
        env: {...process.env, ...extraEnv},
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (cause) {
      errors.set(name, publicProcessError(name, cause));
      throw cause;
    }

    const entry = {
      child,
      command,
      args: [...args],
      extraEnv: {...extraEnv},
      stderr: consumeStderr(child),
    };
    errors.delete(name);
    processes.set(name, entry);
    if (typeof child.once === "function") {
      child.once("error", (error) => handleProcessExit(name, entry, error));
      child.once("exit", (code, signal) => handleProcessExit(
          name,
          entry,
          new Error(`${name} exited (${(code ?? signal) || "unknown"})`),
      ));
    }
    return child;
  }

  function handleProcessExit(name, entry, error) {
    if (processes.get(name) !== entry || stopping) return;
    processes.delete(name);
    errors.set(name, publicProcessError(name, error));
    console.warn(`chrome desktop process exited: ${name}`);

    if (state === "starting" || name === "xvfb") {
      setState("failed");
      return;
    }

    const maxAttempts = name === "chromium" ? 1 : maxRestartAttempts;
    const attempts = restartAttempts.get(name) || 0;
    if (attempts >= maxAttempts) {
      console.warn(`chrome desktop process retry exhausted: ${name}`);
      setState("failed");
      return;
    }

    const nextAttempt = attempts + 1;
    restartAttempts.set(name, nextAttempt);
    if (name === "chromium") browserRestartAttempts = nextAttempt;
    setState("degraded");
    scheduleRestart(name, entry, nextAttempt);
  }

  function scheduleRestart(name, entry, attempt) {
    const backoffMs = restartBackoffMs * (2 ** Math.max(0, attempt - 1));
    console.warn(`chrome desktop process retry scheduled: ${name} attempt ${attempt}`);
    const timer = setTimeoutImpl(() => {
      restartTimers.delete(name);
      if (stopping || state === "failed") return;
      try {
        startProcess(name, entry.command, entry.args, entry.extraEnv);
        if (allRequiredProcessesRunning()) setState("running");
      } catch (cause) {
        errors.set(name, publicProcessError(name, cause));
        setState("failed");
      }
    }, backoffMs);
    restartTimers.set(name, timer);
  }

  async function stop() {
    if (!enabled) return status();
    stopping = true;
    for (const timer of restartTimers.values()) clearTimeoutImpl(timer);
    restartTimers.clear();
    for (const name of ["vnc", "chromium", "taskbar", "windowManager", "xvfb"]) {
      const entry = processes.get(name);
      if (!entry) continue;
      try {
        if (typeof entry.child.kill === "function") entry.child.kill("SIGTERM");
      } catch (error) {
        // Shutdown is best effort; the next start removes only known stale locks.
      }
      processes.delete(name);
    }
    setState("stopped");
    return status();
  }

  function onStateChange(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function notifyStateChange() {
    const snapshot = status();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn("chrome desktop state listener failed");
      }
    }
  }

  function setState(nextState) {
    if (state === nextState) return;
    if (nextState === "failed") {
      for (const timer of restartTimers.values()) clearTimeoutImpl(timer);
      restartTimers.clear();
    }
    state = nextState;
    notifyStateChange();
  }

  function allRequiredProcessesRunning() {
    return REQUIRED_PROCESS_NAMES.every((name) => processes.has(name));
  }

  function status() {
    const processState = Object.fromEntries(PROCESS_NAMES.map((name) => [name, Boolean(processes.get(name))]));
    return {
      state,
      ready: state === "running" && allRequiredProcessesRunning(),
      display: enabled ? config.chromeDisplay : null,
      xvfb: processState.xvfb,
      windowManager: processState.windowManager,
      taskbar: processState.taskbar,
      chromium: processState.chromium,
      vnc: processState.vnc,
      browserRestartAttempts,
      processRestartAttempts: Object.fromEntries(restartAttempts),
      processErrors: Object.fromEntries(errors),
    };
  }
}

async function cleanupStaleLocks(fsImpl, config) {
  if (!config.chromeProfileDir) return;
  await Promise.all(PROFILE_LOCKS.map((lockName) => removeIfPresent(fsImpl, path.join(config.chromeProfileDir, lockName))));
  const displayNumber = String(config.chromeDisplay || "").match(/^:(\d+)$/);
  if (displayNumber) {
    await removeIfPresent(fsImpl, `/tmp/.X${displayNumber[1]}-lock`);
  }
}

async function isDisplayReady(fsImpl, config) {
  const displayNumber = String(config.chromeDisplay || "").match(/^:(\d+)$/);
  if (!displayNumber) throw new Error("Chrome display configuration is invalid");
  const socketPath = `/tmp/.X11-unix/X${displayNumber[1]}`;
  await fsImpl.promises.access(socketPath, fs.constants.F_OK);
  return true;
}

function consumeStderr(child) {
  let stderr = "";
  if (child && child.stderr && typeof child.stderr.on === "function") {
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
  }
  return () => stderr;
}

async function removeIfPresent(fsImpl, targetPath) {
  try {
    await fsImpl.promises.rm(targetPath, {force: true, recursive: false});
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }
}

function publicProcessError(name, error) {
  return `${name} failed; inspect the runner browser status and container logs`;
}

function sanitizeDesktopError(error) {
  return String(error && (error.publicMessage || error.message) || error || "Chrome desktop failed to start")
      .replace(/(?:--user-data-dir|--remote-debugging-port|--remote-debugging-address)(?:=|\s+)\S+/gi, "<redacted-argument>")
      .replace(/(?:\/[^\s]*)(?:profile|chrome|\.mapache)[^\s]*/gi, "<redacted-path>")
      .slice(0, 240);
}

function delay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

module.exports = {
  PROFILE_LOCKS,
  cleanupStaleLocks,
  createChromeDesktopService,
  isDisplayReady,
  publicProcessError,
};
