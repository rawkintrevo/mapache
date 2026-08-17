"use strict";

const fs = require("fs");
const path = require("path");
const {EventEmitter} = require("events");
const {spawn} = require("child_process");

const PROFILE_LOCKS = ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"];

function createChromeDesktopService(config = {}, deps = {}) {
  const enabled = Boolean(config.chromeEnabled || config.runnerCapabilities?.chrome);
  const spawnImpl = deps.spawn || spawn;
  const fsImpl = deps.fs || fs;
  const processes = new Map();
  let state = enabled ? "stopped" : "disabled";
  let stopping = false;
  let browserRestartAttempts = 0;
  let restartTimer = null;

  return {
    start,
    stop,
    status,
    cleanupStaleLocks: () => cleanupStaleLocks(fsImpl, config),
  };

  async function start() {
    if (!enabled) return status();
    if (state === "running") return status();
    stopping = false;
    state = "starting";
    await fsImpl.promises.mkdir(config.chromeProfileDir, {recursive: true, mode: 0o700});
    await cleanupStaleLocks(fsImpl, config);

    startProcess("xvfb", "Xvfb", [
      config.chromeDisplay,
      "-screen", "0", `${config.chromeViewport.width}x${config.chromeViewport.height}x24`,
      "-ac", "-nolisten", "tcp",
    ], {DISPLAY: config.chromeDisplay});
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
    state = "running";
    return status();
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
    const child = spawnImpl(command, args, {
      env: {...process.env, ...extraEnv},
      stdio: ["ignore", "ignore", "pipe"],
    });
    processes.set(name, {child, command, args: [...args]});
    if (typeof child.once === "function") {
      child.once("error", (error) => handleProcessExit(name, error));
      child.once("exit", (code, signal) => handleProcessExit(name, new Error(`${name} exited (${(code ?? signal) || "unknown"})`)));
    }
    return child;
  }

  function handleProcessExit(name, error) {
    const current = processes.get(name);
    if (!current || stopping) return;
    processes.delete(name);
    if (name === "chromium" && state === "running" && browserRestartAttempts < 1) {
      browserRestartAttempts += 1;
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!stopping && state === "running") startChromium();
      }, 250);
      return;
    }
    state = "failed";
    current.error = publicProcessError(name, error);
  }

  async function stop() {
    if (!enabled) return status();
    stopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
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
    state = "stopped";
    return status();
  }

  function status() {
    return {
      state,
      display: enabled ? config.chromeDisplay : null,
      xvfb: Boolean(processes.get("xvfb")),
      windowManager: Boolean(processes.get("windowManager")),
      taskbar: Boolean(processes.get("taskbar")),
      chromium: Boolean(processes.get("chromium")),
      vnc: Boolean(processes.get("vnc")),
      browserRestartAttempts,
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

module.exports = {
  PROFILE_LOCKS,
  cleanupStaleLocks,
  createChromeDesktopService,
  publicProcessError,
};
