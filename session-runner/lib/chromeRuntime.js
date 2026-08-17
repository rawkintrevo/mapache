"use strict";

const {compactErrorMessage} = require("./utils");

function createChromeRuntime(config = {}, deps = {}) {
  const enabled = Boolean(config.chromeEnabled || config.runnerCapabilities?.chrome);
  const desktop = deps.desktop || {
    start: async () => {},
    stop: async () => {},
    status: () => ({}),
  };
  const fetchImpl = deps.fetch || global.fetch;
  const now = deps.now || (() => Date.now());
  const delayImpl = deps.delay || delay;
  let state = enabled ? "starting" : "disabled";
  let error = null;
  let startedAt = null;

  return {
    enabled: () => enabled,
    start,
    status,
    stop,
  };

  async function start() {
    if (!enabled) return status();
    if (state === "ready") return status();
    state = "starting";
    error = null;
    startedAt = now();
    try {
      await desktop.start();
      await waitForCdpReady();
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

  async function waitForCdpReady() {
    if (!fetchImpl) throw new Error("browser readiness probe is unavailable");
    const timeoutMs = Number(config.chromeStartupTimeoutMs || 30000);
    const deadline = now() + timeoutMs;
    const url = `http://${config.chromeCdpHost || "127.0.0.1"}:${config.chromeCdpPort || 9222}/json/version`;
    let lastError = null;
    while (now() <= deadline) {
      try {
        const response = await fetchImpl(url);
        if (response && response.ok) {
          const body = await response.json();
          if (body && typeof body.webSocketDebuggerUrl === "string") return body;
          lastError = new Error("CDP readiness response was incomplete");
        } else {
          lastError = new Error(`CDP readiness returned ${response && response.status || "no status"}`);
        }
      } catch (cause) {
        lastError = cause;
      }
      await delayImpl(Math.min(250, Math.max(1, deadline - now())));
    }
    throw new Error(`Chrome did not become ready: ${sanitizeBrowserError(lastError)}`);
  }

  function status() {
    const desktopStatus = typeof desktop.status === "function" ? desktop.status() || {} : {};
    return {
      enabled,
      state,
      ready: state === "ready",
      startedAt,
      error,
      display: enabled ? config.chromeDisplay : null,
      viewport: enabled ? config.chromeViewport : null,
      cdp: enabled ? {
        host: config.chromeCdpHost,
        port: config.chromeCdpPort,
        ready: state === "ready",
      } : null,
      vnc: enabled ? {
        host: config.chromeVncHost,
        port: config.chromeVncPort,
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
  sanitizeBrowserError,
};
