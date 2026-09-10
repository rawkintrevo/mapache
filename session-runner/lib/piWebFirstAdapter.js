"use strict";

const net = require("node:net");
const {EventEmitter} = require("node:events");

const ADAPTER_PROTOCOL = "mapache-pi-web-first/1";
const DEFAULT_ADAPTER_REVISION = "gate-a-0.1.0";
const MAX_LINE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Client for the image-owned Pi TUI extension bridge used by Gate A.
 *
 * The bridge is deliberately fail-closed. It is not allowed to turn a
 * disconnected structured request into PTY input, because that would make a
 * browser command look accepted without a causal adapter boundary.
 */
function createPiWebFirstAdapter({
  socketPath,
  connect = net.createConnection,
  adapterRevision = process.env.MAPACHE_PI_WEB_FIRST_ADAPTER_REVISION || DEFAULT_ADAPTER_REVISION,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const events = new EventEmitter();
  const pending = new Map();
  let socket = null;
  let buffer = "";
  let nextRequestId = 0;
  let identity = null;
  let connected = false;

  return {
    protocol: ADAPTER_PROTOCOL,
    adapterRevision,
    isConnected: () => connected,
    identity: () => identity ? {...identity} : null,
    on(event, listener) {
      events.on(event, listener);
      return () => events.off(event, listener);
    },
    async connect(options = {}) {
      if (connected && socket) return {...identity};
      if (!socketPath) throw adapterError("web_first_adapter_socket_missing");
      const connectTimeoutMs = positiveTimeout(options.timeoutMs, timeoutMs);
      const next = connect(socketPath);
      socket = next;
      buffer = "";
      connected = false;
      next.setEncoding?.("utf8");
      next.on("data", parseData);
      next.once("error", (error) => handleDisconnect(error));
      next.once("close", () => handleDisconnect());
      return await waitForHandshake(connectTimeoutMs);
    },
    async request(operation, payload = {}, options = {}) {
      if (!connected || !socket || socket.destroyed) throw adapterError("web_first_adapter_unavailable");
      const requestId = String(options.requestId || `mapache-web-first-${++nextRequestId}`);
      const expectedSessionGeneration = options.expectedSessionGeneration ?? identity?.sessionGeneration;
      const message = {
        type: "request",
        id: requestId,
        operation: String(operation || "").trim(),
        payload,
        ...(expectedSessionGeneration === undefined ? {} : {expectedSessionGeneration}),
      };
      return await send(message, positiveTimeout(options.timeoutMs, timeoutMs));
    },
    disconnect() {
      const current = socket;
      socket = null;
      connected = false;
      identity = null;
      if (current && !current.destroyed) current.destroy();
      rejectPending(adapterError("web_first_adapter_disconnected"));
    },
  };

  function waitForHandshake(waitTimeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete("__handshake__");
        reject(adapterError("web_first_adapter_handshake_timeout"));
      }, waitTimeoutMs);
      pending.set("__handshake__", {
        timer,
        resolve,
        reject,
        handshake: true,
      });
    });
  }

  function send(message, sendTimeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(message.id);
        reject(adapterError("web_first_adapter_request_timeout"));
      }, sendTimeoutMs);
      pending.set(message.id, {timer, resolve, reject});
      try {
        socket.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(message.id);
        reject(error);
      }
    });
  }

  function parseData(chunk) {
    buffer += String(chunk || "");
    if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES * 2) {
      buffer = buffer.slice(-MAX_LINE_BYTES);
    }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        events.emit("protocol_error", {code: "web_first_adapter_invalid_json"});
        continue;
      }
      handleMessage(message);
    }
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    if (message.type === "handshake") {
      const result = validateHandshake(message, adapterRevision);
      const handshake = pending.get("__handshake__");
      if (!result.ok) {
        if (handshake) {
          clearTimeout(handshake.timer);
          pending.delete("__handshake__");
          handshake.reject(adapterError(result.code));
        }
        handleDisconnect(adapterError(result.code));
        return;
      }
      identity = result.identity;
      connected = true;
      if (handshake) {
        clearTimeout(handshake.timer);
        pending.delete("__handshake__");
        handshake.resolve({...identity});
      }
      events.emit("handshake", {...identity});
      return;
    }
    if (message.type === "event") {
      events.emit("event", message);
      return;
    }
    if (message.type !== "response" || !message.id) return;
    const request = pending.get(String(message.id));
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(String(message.id));
    if (message.success === false) {
      const error = adapterError(String(message.error || "web_first_adapter_request_failed"));
      error.details = message;
      request.reject(error);
      return;
    }
    request.resolve(message.result === undefined ? message : message.result);
  }

  function handleDisconnect(error) {
    const wasConnected = connected;
    socket = null;
    connected = false;
    identity = null;
    rejectPending(error || adapterError("web_first_adapter_disconnected"));
    if (wasConnected) events.emit("disconnect", error ? {error: String(error.message || error)} : {});
  }

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }
}

function validateHandshake(message, expectedAdapterRevision) {
  if (message.protocol !== ADAPTER_PROTOCOL) return {ok: false, code: "web_first_adapter_protocol_mismatch"};
  if (message.runtime !== "pi-tui-extension") return {ok: false, code: "web_first_adapter_runtime_mismatch"};
  if (!Number.isSafeInteger(message.sessionGeneration) || message.sessionGeneration < 1) {
    return {ok: false, code: "web_first_adapter_invalid_generation"};
  }
  if (!nonEmpty(message.piSession) || !nonEmpty(message.adapter)) {
    return {ok: false, code: "web_first_adapter_identity_missing"};
  }
  if (String(message.adapter) !== String(expectedAdapterRevision)) {
    return {ok: false, code: "web_first_adapter_revision_mismatch"};
  }
  const packageVersion = message.package && typeof message.package === "object" ? message.package.version : "";
  if (!nonEmpty(packageVersion)) return {ok: false, code: "web_first_adapter_package_version_missing"};
  return {
    ok: true,
    identity: {
      protocol: message.protocol,
      runtime: message.runtime,
      sessionGeneration: message.sessionGeneration,
      piSession: String(message.piSession),
      adapter: String(message.adapter),
      package: {name: String(message.package.name || ""), version: String(packageVersion)},
      pid: Number.isSafeInteger(message.pid) ? message.pid : null,
    },
  };
}

function positiveTimeout(value, fallback) {
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate > 0 ? candidate : fallback;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function adapterError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {
  ADAPTER_PROTOCOL,
  DEFAULT_ADAPTER_REVISION,
  MAX_LINE_BYTES,
  createPiWebFirstAdapter,
  validateHandshake,
};
