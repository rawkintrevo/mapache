"use strict";

const http = require("node:http");
const {createSshTransportPool} = require("./sshTransport");
const {workspacePath, entryHtml, rewriteEntryHtml, assetModule, rewriteAssetModule,
  assetStyle, rewriteAssetStyle, publicLocation} = require("./workspacePaths");

const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const ACCESS_QUERY = "mapache_access";
// The embedded pi-web-ui uses the parent origin from document.referrer to
// complete its postMessage readiness handshake. Preserve only that origin
// across the token-to-cookie redirect; the token itself is removed from the
// redirect location and never forwarded to the guest.
const EMBEDDED_AGENT_REFERRER_POLICY = "strict-origin-when-cross-origin";
const MAX_TOKEN_BYTES = 8192;
const MAX_LIFETIME_MS = 55 * 60 * 1000;

function createGateway({resolve, request = http.request, transportFactory = createSshTransportPool()} = {}) {
  if (typeof resolve !== "function") throw new Error("gateway_resolver_required");
  const server = http.createServer((req, res) => {
    forward(req, res).catch(() => deny(res));
  });
  server.on("upgrade", (req, socket, head) => {
    forward(req, socket, head).catch(() => deny(socket));
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 0;
  const live = new Set();
  server.on("close", () => { for (const close of live) close(); });
  return server;

  async function forward(req, downstream, head) {
    const websocket = head !== undefined;
    const input = authorizationInput(req);
    const target = await resolve(input);
    validateTarget(target);
    if (input.prefix && target.transport !== "ssh") throw new Error("not_found");
    if (downstream.destroyed) return;
    // The gateway consumes the URL token before forwarding. Establish browser
    // authority here so subsequent assets and WebSockets carry it as a cookie.
    if (!websocket && req.method === "GET" && target.transport === "ssh" && input.bootstrap) {
      downstream.writeHead(303, {
        location: input.publicPath,
        "set-cookie": `mapache_access=${encodeURIComponent(input.token)}; Path=${input.prefix}/agent; HttpOnly; Secure; SameSite=None`,
        "cache-control": "no-store",
        "referrer-policy": EMBEDDED_AGENT_REFERRER_POLICY,
      });
      downstream.end();
      return;
    }

    let stopped = false;
    let renewTimer;
    let expiryTimer;
    let lifetimeTimer;
    let transport;
    let upstream;
    let upstreamSocket;
    const close = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(renewTimer);
      clearTimeout(expiryTimer);
      clearTimeout(lifetimeTimer);
      live.delete(close);
      upstream?.destroy?.();
      upstreamSocket?.destroy?.();
      transport?.close?.();
      downstream.destroy?.();
    };
    live.add(close);
    downstream.once?.("close", close);
    downstream.once?.("error", close);
    req.once?.("aborted", close);
    req.once?.("error", close);
    lifetimeTimer = setTimeout(close, MAX_LIFETIME_MS);
    lifetimeTimer.unref?.();

    const guard = (authorized) => {
      clearTimeout(expiryTimer);
      const remaining = Number(authorized.validUntil) - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) return close();
      expiryTimer = setTimeout(close, remaining);
      expiryTimer.unref?.();
      renewTimer = setTimeout(async () => {
        try {
          const next = await resolve(input);
          validateTarget(next);
          if (!sameAuthority(target, next)) throw new Error("authority_changed");
          if (!stopped) guard(next);
        } catch {
          close();
        }
      }, Math.min(5000, Math.max(1, Math.floor(remaining / 2))));
      renewTimer.unref?.();
    };
    guard(target);
    if (stopped) return;

    transport = target.transport === "direct" ? {
      hostname: target.address,
      port: target.port,
      close: () => {},
    } : await transportFactory(target);
    if (stopped) return transport.close?.();
    const headers = forwardedHeaders(req, input.token, target, websocket, input.shutdownToken, input.path);
    if (entryHtml(input) || assetModule(input) || assetStyle(input)) {
      headers["accept-encoding"] = "identity";
      delete headers["if-none-match"];
      delete headers["if-modified-since"];
    }
    const options = {
      hostname: transport.hostname || "127.0.0.1",
      port: transport.port,
      path: input.forwardPath,
      method: req.method,
      headers,
    };
    upstream = request(options);
    upstream.on("error", () => {
      if (!websocket && !downstream.headersSent) downstream.writeHead(502, {"cache-control": "no-store"});
      close();
    });
    upstream.on("response", (response) => {
      if (stopped) return response.destroy();
      if (websocket) {
        response.resume();
        deny(downstream);
        return;
      }
      const responseHeaders = {...cleanHeaders(response.headers), "cache-control": "no-store"};
      if (responseHeaders.location) responseHeaders.location = publicLocation(responseHeaders.location, input.prefix);
      if (input.prefix) delete responseHeaders["set-cookie"];
      response.on("error", close);
      const rewriteHtml = entryHtml(input) && /^text\/html\b/i.test(responseHeaders["content-type"] || "");
      const rewriteModule = assetModule(input) && /^(?:text|application)\/(?:javascript|ecmascript)\b/i.test(responseHeaders["content-type"] || "");
      const rewriteStyle = assetStyle(input) && /^text\/css\b/i.test(responseHeaders["content-type"] || "");
      if (response.statusCode === 200 && (rewriteHtml || rewriteModule || rewriteStyle)) {
        if (responseHeaders["content-encoding"] && responseHeaders["content-encoding"] !== "identity") return close();
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > (rewriteHtml ? 1 : 8) * 1024 * 1024) return close();
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (stopped) return;
          delete responseHeaders["content-length"];
          delete responseHeaders.etag;
          downstream.writeHead(200, responseHeaders);
          const rewrite = rewriteHtml ? rewriteEntryHtml : rewriteModule ? rewriteAssetModule : rewriteAssetStyle;
          downstream.end(rewrite(Buffer.concat(chunks).toString("utf8"), input.prefix));
        });
        return;
      }
      downstream.writeHead(response.statusCode || 502, responseHeaders);
      response.pipe(downstream);
    });
    upstream.on("upgrade", (response, socket, upstreamHead) => {
      if (!websocket || stopped) return socket.destroy();
      upstreamSocket = socket;
      const responseHeaders = cleanHeaders(response.headers);
      responseHeaders.connection = "Upgrade";
      responseHeaders.upgrade = "websocket";
      downstream.write("HTTP/1.1 101 Switching Protocols\r\n" +
        Object.entries(responseHeaders).flatMap(([key, value]) => (Array.isArray(value) ? value : [value])
            .map((item) => `${key}: ${item}\r\n`)).join("") + "\r\n");
      if (upstreamHead.length) downstream.write(upstreamHead);
      if (head.length) socket.write(head);
      socket.on("error", close);
      socket.once("close", close);
      socket.pipe(downstream);
      downstream.pipe(socket);
    });
    if (websocket) upstream.end();
    else req.pipe(upstream);
  }
}

function authorizationInput(req) {
  const host = normalizeHost(req.headers?.host);
  const parsed = new URL(req.url || "/", `https://${host}`);
  if (!parsed.pathname.startsWith("/") || parsed.pathname.startsWith("//") || parsed.pathname.includes("..") || decodeURIComponent(parsed.pathname).includes("..")) {
    throw new Error("invalid_request");
  }
  const token = parsed.searchParams.get(ACCESS_QUERY) || readCookie(req.headers?.cookie);
  if (!token || Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw new Error("not_found");
  parsed.searchParams.delete(ACCESS_QUERY);
  const {prefix, privatePath} = workspacePath(parsed.pathname);
  return {
    host,
    path: parsed.pathname,
    prefix,
    privatePath,
    publicPath: `${parsed.pathname}${parsed.search}`,
    forwardPath: `${privatePath}${parsed.search}`,
    bootstrap: new URL(req.url || "/", `https://${host}`).searchParams.has(ACCESS_QUERY),
    origin: String(req.headers?.origin || ""),
    token,
    shutdownToken: String(req.headers?.["x-shutdown-token"] || ""),
  };
}

function forwardedHeaders(req, token, target, websocket = false, shutdownToken = "", requestPath = "") {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers || {})) {
    const lower = name.toLowerCase();
    if (HOP_HEADERS.has(lower) || ["authorization", "cookie", "host", "origin", "referer", "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto", "x-shutdown-token"].includes(lower)) continue;
    if (value !== undefined) headers[name] = value;
  }
  headers.host = target.transport === "ssh" ? `${target.guestAddress}:${target.guestPort}` : target.host || target.address;
  // The runner's agent gateway requires a same-origin value for state-changing
  // HTTP requests and WebSocket handshakes.  The browser origin belongs to the
  // public gateway and is intentionally not forwarded; synthesize the origin
  // that matches the private request Host instead.
  headers.origin = `http://${headers.host}`;
  headers.cookie = `mapache_access=${encodeURIComponent(token)}`;
  if (shutdownToken && requestPath === "/runner/health") headers["x-shutdown-token"] = shutdownToken;
  if (websocket) {
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
  }
  return headers;
}

function validateTarget(target) {
  if (!target || !Number.isSafeInteger(Number(target.generation)) || !target.sessionId || !target.bootId ||
      !(Number(target.validUntil) > Date.now()) || Number(target.validUntil) > Date.now() + 15_000) throw new Error("invalid_target");
  if (target.transport === "direct") {
    if (!isComputeAddress(target.address) || Number(target.port) !== 8080) throw new Error("invalid_target");
    return;
  }
  if (target.transport !== "ssh" || !isPublicHost(target.sshAddress) || !Number.isInteger(Number(target.sshPort)) ||
      Number(target.sshPort) < 1 || Number(target.sshPort) > 65535 ||
      !/^[a-z_][a-z0-9_-]{0,31}$/i.test(String(target.sshUsername || "")) ||
      !isGuestAddress(target.guestAddress) || Number(target.guestPort) !== 8080 ||
      typeof target.privateKey !== "string" || target.privateKey.length < 64 || target.privateKey.length > 16 * 1024 ||
      !/^SHA256\/[A-Za-z0-9+/=_-]{8,}$/.test(String(target.hostKeyFingerprint || ""))) throw new Error("invalid_target");
}

function sameAuthority(a, b) {
  const keys = a?.transport === "ssh" ? ["transport", "sshAddress", "sshPort", "sshUsername", "hostKeyFingerprint", "guestAddress", "guestPort", "sessionId", "generation", "bootId"] :
    ["transport", "address", "port", "sessionId", "generation", "bootId"];
  return keys.every((key) => String(a[key]) === String(b[key]));
}

function cleanHeaders(input = {}) {
  const output = {...input};
  for (const name of String(input.connection || "").split(",")) delete output[name.trim().toLowerCase()];
  for (const name of HOP_HEADERS) delete output[name];
  return output;
}

function normalizeHost(value) {
  const host = String(value || "").trim().toLowerCase().replace(/:\d+$/, "");
  if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(host)) throw new Error("invalid_request");
  return host;
}

function readCookie(value) {
  const match = String(value || "").match(/(?:^|;\s*)mapache_access=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function isGuestAddress(value) {
  return /^192\.168\.250\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/.test(String(value || ""));
}

function isComputeAddress(value) {
  return /^10\.90\.0\.(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/.test(String(value || ""));
}

function isPublicHost(value) {
  const host = String(value || "").trim().toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata" || host === "metadata.google.internal") return false;
  if (/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|224\.)/.test(host)) return false;
  const match = host.match(/^172\.(\d+)\./);
  return !(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function deny(response) {
  if (!response || response.destroyed) return;
  if (typeof response.writeHead === "function") {
    response.writeHead(404, {"cache-control": "no-store"});
    response.end();
  } else {
    response.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  }
}

module.exports = {
  authorizationInput,
  createGateway,
  sameAuthority,
  validateTarget,
};
