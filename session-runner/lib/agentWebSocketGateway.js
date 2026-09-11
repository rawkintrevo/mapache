"use strict";

const WebSocket = require("ws");
const {normalizeQuery} = require("./agentGateway");

const DEFAULT_PUBLIC_PREFIX = "/agent";
const DEFAULT_UPSTREAM_HOST = "127.0.0.1";
const DEFAULT_UPSTREAM_PORT = 8787;
const DEFAULT_QUEUE_LIMIT_BYTES = 8 * 1024 * 1024;
const AGENT_EXPIRED_CODE = 4001;
const AGENT_EXPIRED_REASON = "agent_access_expired";

/** Authenticated frame-preserving proxy for pi-web-ui's /ws endpoint. */
function createAgentWebSocketGateway({
  accessVerifier,
  clientWss,
  enabled = true,
  getUpstreamHeaders = () => ({}),
  WebSocketClass = WebSocket,
  publicPrefix = DEFAULT_PUBLIC_PREFIX,
  upstreamHost = DEFAULT_UPSTREAM_HOST,
  upstreamPort = DEFAULT_UPSTREAM_PORT,
  queueLimitBytes = DEFAULT_QUEUE_LIMIT_BYTES,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!clientWss || typeof clientWss.handleUpgrade !== "function") {
    throw new Error("Agent WebSocket gateway requires a noServer WebSocketServer.");
  }
  const prefix = normalizePrefix(publicPrefix);
  const path = `${prefix}/ws`;
  const host = String(upstreamHost || DEFAULT_UPSTREAM_HOST).trim() || DEFAULT_UPSTREAM_HOST;
  const port = Number(upstreamPort || DEFAULT_UPSTREAM_PORT);
  const maxQueuedBytes = positiveNumber(queueLimitBytes, DEFAULT_QUEUE_LIMIT_BYTES);

  return {handleUpgrade, originAllowed};

  function handleUpgrade(request, socket, head) {
    if (!enabled) {
      rejectUpgrade(socket, 404);
      return;
    }
    const parsed = parseRequest(request, path);
    if (!parsed.ok) {
      rejectUpgrade(socket, parsed.status || 404);
      return;
    }
    const token = typeof accessVerifier?.extractToken === "function" ? accessVerifier.extractToken(request) : "";
    if (!token || typeof accessVerifier?.verify !== "function" || !accessVerifier.verify(token)) {
      rejectUpgrade(socket, 404);
      return;
    }
    if (!originAllowed(request)) {
      rejectUpgrade(socket, 403);
      return;
    }

    let upstreamHeaders;
    try {
      upstreamHeaders = getUpstreamHeaders() || {};
    } catch (error) {
      upstreamHeaders = {};
    }
    const privateToken = upstreamHeaders["x-pi-token"];
    if (typeof privateToken !== "string" || !privateToken) {
      rejectUpgrade(socket, 503);
      return;
    }

    try {
      clientWss.handleUpgrade(request, socket, head, (client) => {
        bridge(client, parsed.query, token, privateToken);
      });
    } catch (error) {
      rejectUpgrade(socket, 502);
    }
  }

  function bridge(client, query, accessToken, privateToken) {
    let closed = false;
    let upstream;
    let expiryTimer = null;
    const closePair = (code, reason) => {
      if (closed) return;
      closed = true;
      clearExpiry();
      toUpstream.clear();
      toClient.clear();
      closeSocket(client, code, reason);
      closeSocket(upstream, code, reason);
    };
    const toUpstream = createQueue(client, () => upstream, () => closePair(1011, "agent_proxy_error"));
    const toClient = createQueue(null, () => client, () => closePair(1011, "agent_proxy_error"));

    client.on("message", (data, isBinary) => {
      toUpstream.push(data, isBinary);
    });
    client.once("error", () => closePair(1011, "agent_proxy_error"));
    client.once("close", () => {
      closed = true;
      clearExpiry();
      toUpstream.clear();
      toClient.clear();
      closeSocket(upstream, 1000, "client_closed");
    });

    const maxAgeMs = typeof accessVerifier?.maxAgeMs === "function" ? accessVerifier.maxAgeMs(accessToken) : 0;
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
      closePair(AGENT_EXPIRED_CODE, AGENT_EXPIRED_REASON);
      return;
    }
    expiryTimer = setTimeoutImpl(() => closePair(AGENT_EXPIRED_CODE, AGENT_EXPIRED_REASON), Math.max(1, maxAgeMs));

    try {
      upstream = new WebSocketClass(`ws://${formatHost(host)}:${port}/ws${query}`, {
        headers: {
          host: `${host}:${port}`,
          "x-pi-token": privateToken,
        },
        // The downstream WebSocketServer terminates framing and compression;
        // forwarding is done with message payloads, so do not copy its headers.
        perMessageDeflate: false,
      });
    } catch (error) {
      closePair(1013, "agent_unavailable");
      return;
    }
    upstream.once("open", () => {
      if (closed) {
        closeSocket(upstream, 1000, "client_closed");
        return;
      }
      toUpstream.flush();
    });
    upstream.on("message", (data, isBinary) => {
      toClient.push(data, isBinary);
    });
    upstream.once("error", () => closePair(1013, "agent_unavailable"));
    upstream.once("close", (code, reason) => {
      if (closed) return;
      closed = true;
      clearExpiry();
      toUpstream.clear();
      toClient.clear();
      closeSocket(client, validCloseCode(code) ? code : 1011, safeReason(reason));
    });

    function clearExpiry() {
      if (expiryTimer === null) return;
      clearTimeoutImpl(expiryTimer);
      expiryTimer = null;
    }
  }

  function createQueue(source, destination, fail) {
    const queue = [];
    let queuedBytes = 0;
    let sending = false;
    let paused = false;

    return {clear, flush, push};

    function push(data, isBinary) {
      const payload = toBuffer(data);
      const nextBytes = queuedBytes + payload.byteLength;
      if (nextBytes > maxQueuedBytes) {
        fail();
        return;
      }
      queue.push({isBinary: Boolean(isBinary), payload});
      queuedBytes = nextBytes;
      if (queuedBytes > maxQueuedBytes / 2) pauseSource();
      flush();
    }

    function flush() {
      const target = destination();
      if (sending || !queue.length || !target || target.readyState !== WebSocketClass.OPEN) return;
      const item = queue.shift();
      queuedBytes -= item.payload.byteLength;
      sending = true;
      try {
        target.send(item.payload, {binary: item.isBinary}, (error) => {
          sending = false;
          if (error) {
            fail();
            return;
          }
          if (queuedBytes <= maxQueuedBytes / 4) resumeSource();
          flush();
        });
      } catch (error) {
        sending = false;
        fail();
      }
    }

    function clear() {
      queue.length = 0;
      queuedBytes = 0;
      resumeSource();
    }

    function pauseSource() {
      if (paused || !source?._socket || typeof source._socket.pause !== "function") return;
      source._socket.pause();
      paused = true;
    }

    function resumeSource() {
      if (!paused || !source?._socket || typeof source._socket.resume !== "function") return;
      source._socket.resume();
      paused = false;
    }
  }

  function originAllowed(request) {
    const supplied = String(request?.headers?.origin || "").trim();
    if (!supplied || supplied.toLowerCase() === "null") return false;
    try {
      const expected = requestOrigin(request);
      return new URL(supplied).origin.toLowerCase() === new URL(expected).origin.toLowerCase();
    } catch (error) {
      return false;
    }
  }
}

function parseRequest(request, expectedPath) {
  try {
    const url = new URL(request?.url || "/", "http://mapache.local");
    if (url.pathname !== expectedPath) return {ok: false, status: 404};
    normalizeQuery(url.searchParams);
    return {ok: true, query: url.search};
  } catch (error) {
    return {ok: false, status: 400};
  }
}

function requestOrigin(request) {
  const forwardedProto = String(request?.headers?.["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const protocol = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : request.socket?.encrypted ? "https" : "http";
  return `${protocol}://${request?.headers?.host || "localhost"}`;
}

function closeSocket(socket, code, reason) {
  if (!socket) return;
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
    try {
      socket.close(code, safeReason(reason));
    } catch (error) {
      socket.terminate?.();
    }
    return;
  }
  socket.terminate?.();
}

function rejectUpgrade(socket, status) {
  if (!socket || socket.destroyed) return;
  try {
    socket.write(`HTTP/1.1 ${status} ${statusText(status)}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } finally {
    socket.destroy();
  }
}

function statusText(status) {
  return {403: "Forbidden", 404: "Not Found", 502: "Bad Gateway", 503: "Service Unavailable"}[status] || "Bad Request";
}

function normalizePrefix(value) {
  const clean = `/${String(value || DEFAULT_PUBLIC_PREFIX).replace(/^\/+|\/+$/g, "")}`;
  return clean === "/" ? DEFAULT_PUBLIC_PREFIX : clean;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : fallback;
}

function formatHost(value) {
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value);
}

function validCloseCode(code) {
  return Number.isInteger(code) && ((code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999));
}

function safeReason(value) {
  let reason = Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
  while (Buffer.byteLength(reason, "utf8") > 123) reason = reason.slice(0, -1);
  return reason;
}

module.exports = {
  AGENT_EXPIRED_CODE,
  createAgentWebSocketGateway,
  requestOrigin,
};
