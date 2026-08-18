"use strict";

const net = require("net");
const {compactErrorMessage} = require("./utils");

const REQUIRED_PROCESS_NAMES = ["xvfb", "windowManager", "taskbar", "chromium", "vnc"];

function createChromeRuntime(config = {}, deps = {}) {
  const enabled = Boolean(config.chromeEnabled || config.runnerCapabilities?.chrome);
  const desktop = deps.desktop || {
    start: async () => {},
    stop: async () => {},
    status: () => ({}),
  };
  const fetchImpl = deps.fetch || global.fetch;
  const probeVncImpl = deps.probeVnc || (() => probeTcpPort(
      deps.net || net,
      config.chromeVncHost || "127.0.0.1",
      config.chromeVncPort || 5900,
  ));
  const now = deps.now || (() => Date.now());
  const delayImpl = deps.delay || delay;
  let state = enabled ? "starting" : "disabled";
  let error = null;
  let startedAt = null;
  let cdpReady = false;
  let stopping = false;
  let readinessPromise = null;
  if (typeof desktop.onStateChange === "function") desktop.onStateChange(handleDesktopStateChange);

  return {
    enabled: () => enabled,
    start,
    status,
    stop,
  };

  async function start() {
    if (!enabled) return status();
    if (state === "ready") return status();
    stopping = false;
    state = "starting";
    error = null;
    cdpReady = false;
    startedAt = now();
    try {
      await desktop.start();
      await waitForDesktopReady();
      await waitForCdpReady();
      await waitForDesktopReady();
      if (!isDesktopReady(readDesktopStatus())) throw new Error("Chrome desktop became unavailable during startup");
      state = "ready";
      return status();
    } catch (cause) {
      error = sanitizeBrowserError(cause);
      state = "failed";
      try {
        await desktop.stop();
      } catch (stopError) {
        // Keep the original startup failure actionable without logging process details.
      }
      const startupError = new Error(error);
      startupError.publicMessage = error;
      throw startupError;
    }
  }

  async function waitForDesktopReady() {
    const timeoutMs = Number(config.chromeStartupTimeoutMs || 30000);
    const deadline = now() + timeoutMs;
    let lastError = null;
    while (now() <= deadline) {
      const desktopStatus = readDesktopStatus();
      if (desktopStatus.state === "failed") {
        throw new Error("Chrome desktop process supervision failed");
      }
      if (isDesktopReady(desktopStatus)) {
        try {
          if (await probeVncImpl()) return;
        } catch (cause) {
          lastError = cause;
        }
      }
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await delayImpl(Math.min(250, Math.max(1, remaining)));
    }
    throw new Error(`Chrome desktop did not become ready: ${sanitizeBrowserError(lastError)}`);
  }

  async function waitForCdpReady() {
    if (!fetchImpl) throw new Error("browser readiness probe is unavailable");
    const timeoutMs = Number(config.chromeStartupTimeoutMs || 30000);
    const deadline = now() + timeoutMs;
    const url = `http://${config.chromeCdpHost || "127.0.0.1"}:${config.chromeCdpPort || 9222}/json/version`;
    let lastError = null;
    cdpReady = false;
    while (now() <= deadline) {
      try {
        const response = await fetchImpl(url);
        if (response && response.ok) {
          const body = await response.json();
          if (body && typeof body.webSocketDebuggerUrl === "string") {
            cdpReady = true;
            return body;
          }
          lastError = new Error("CDP readiness response was incomplete");
        } else {
          lastError = new Error(`CDP readiness returned ${response && response.status || "no status"}`);
        }
      } catch (cause) {
        lastError = cause;
      }
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await delayImpl(Math.min(250, Math.max(1, remaining)));
    }
    throw new Error(`Chrome did not become ready: ${sanitizeBrowserError(lastError)}`);
  }

  function handleDesktopStateChange(desktopStatus) {
    if (stopping || !enabled) return;
    const ready = isDesktopReady(desktopStatus);
    if (desktopStatus && desktopStatus.state === "failed") {
      cdpReady = false;
      state = "failed";
      error = "Chrome desktop process supervision failed";
      return;
    }
    if (!ready) {
      if (!desktopStatus || !desktopStatus.chromium) cdpReady = false;
      if (state === "ready") state = "degraded";
      return;
    }
    if (state === "degraded") beginReadinessRecovery();
  }

  function beginReadinessRecovery() {
    if (readinessPromise || stopping || state === "failed") return;
    readinessPromise = (async () => {
      try {
        await waitForDesktopReady();
        await waitForCdpReady();
        if (isDesktopReady(readDesktopStatus())) {
          error = null;
          state = "ready";
        }
      } catch (cause) {
        if (readDesktopStatus().state === "failed") {
          state = "failed";
        } else {
          state = "degraded";
          error = sanitizeBrowserError(cause);
        }
      } finally {
        readinessPromise = null;
      }
    })();
  }

  function readDesktopStatus() {
    return typeof desktop.status === "function" ? desktop.status() || {} : {};
  }

  function status() {
    const desktopStatus = readDesktopStatus();
    const desktopReady = isDesktopReady(desktopStatus);
    if (desktopStatus.state === "failed" && state !== "disabled") {
      state = "failed";
      cdpReady = false;
    }
    if (state === "ready" && (!desktopReady || !cdpReady)) {
      state = desktopStatus.state === "failed" ? "failed" : "degraded";
    }
    const ready = state === "ready" && cdpReady && desktopReady;
    return {
      enabled,
      state,
      ready,
      startedAt,
      error,
      display: enabled ? config.chromeDisplay : null,
      viewport: enabled ? config.chromeViewport : null,
      cdp: enabled ? {
        host: config.chromeCdpHost,
        port: config.chromeCdpPort,
        ready,
      } : null,
      vnc: enabled ? {
        host: config.chromeVncHost,
        port: config.chromeVncPort,
        ready: desktopReady && Boolean(desktopStatus.vnc),
      } : null,
      noVnc: enabled ? {
        port: config.chromeNoVncPort,
        path: "/browser/",
      } : null,
      processes: enabled ? desktopStatus : null,
    };
  }

  async function stop() {
    if (!enabled) return status();
    stopping = true;
    cdpReady = false;
    try {
      await desktop.stop();
      state = "disabled";
      error = null;
    } catch (cause) {
      error = sanitizeBrowserError(cause);
      state = "failed";
      throw cause;
    }
    return status();
  }
}

function isDesktopReady(status) {
  if (!status || status.state === "failed") return false;
  if (status.state && status.state !== "running") return false;
  const hasProcessState = REQUIRED_PROCESS_NAMES.some((name) => Object.prototype.hasOwnProperty.call(status, name));
  if (!hasProcessState) return status.ready === true;
  return REQUIRED_PROCESS_NAMES.every((name) => status[name] === true || status[name] === "running");
}

function probeTcpPort(netImpl, host, port) {
  return new Promise((resolve, reject) => {
    const socket = netImpl.connect({host, port});
    let settled = false;
    const finish = (callback) => (value) => {
      if (settled) return;
      settled = true;
      if (typeof socket.destroy === "function") socket.destroy();
      callback(value);
    };
    socket.once("connect", finish(resolve));
    socket.once("error", finish(reject));
    const onTimeout = finish(reject);
    socket.once("timeout", () => onTimeout(new Error("VNC readiness timed out")));
    if (typeof socket.setTimeout === "function") socket.setTimeout(1000);
  });
}

function sanitizeBrowserError(error) {
  const value = compactErrorMessage(error && (error.publicMessage || error.message) || error || "browser runtime failed") || "browser runtime failed";
  return value
      .replace(/(?:--user-data-dir|--remote-debugging-port|--remote-debugging-address)(?:=|\s+)\S+/gi, "<redacted-argument>")
      .replace(/(?:\/[^\s]*)(?:profile|chrome|\.mapache)[^\s]*/gi, "<redacted-path>")
      .slice(0, 240);
}

function delay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

module.exports = {
  createChromeRuntime,
  isDesktopReady,
  probeTcpPort,
  sanitizeBrowserError,
};
