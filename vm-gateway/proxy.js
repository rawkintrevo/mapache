"use strict";
const http = require("node:http");

const HOP_HEADERS = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];
function cleanHeaders(input) {
  const result = {...input};
  for (const name of String(input.connection || "").split(",")) delete result[name.trim().toLowerCase()];
  for (const name of HOP_HEADERS) delete result[name];
  return result;
}
function authorizationInput(req) {
  const host = req.headers.host;
  if (typeof host !== "string" || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(host) ||
      !req.url.startsWith("/") || req.url.startsWith("//")) throw new Error("invalid_request");
  const url = new URL(req.url, `https://${host}`);
  const cookie = String(req.headers.cookie || "").match(/(?:^|;\s*)mapache_access=([^;]+)/);
  return {host, path: url.pathname, origin: req.headers.origin || "",
    token: url.searchParams.get("mapache_access") || (cookie ? decodeURIComponent(cookie[1]) : ""),
    shutdownToken: req.headers["x-shutdown-token"] || ""};
}
function validateTarget(target) {
  if (!target || !/^10\.90\.0\.(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/.test(target.address) ||
      target.port !== 8080 || !target.sessionId || !target.bootId || !Number.isSafeInteger(target.generation) ||
      !(target.validUntil > Date.now()) || target.validUntil > Date.now() + 15000) throw new Error("invalid_target");
}
function sameAuthority(a, b) {
  return ["address", "port", "sessionId", "generation", "bootId"].every(key => a[key] === b[key]);
}

function createGateway({resolve, request = http.request, validate = validateTarget}) {
  const server = http.createServer((req, res) => { forward(req, res).catch(() => deny(res)); });
  server.on("upgrade", (req, socket, head) => {
    forward(req, socket, head).catch(() => deny(socket));
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 0; // Streaming bodies are bounded by the connection deadline below.
  const live = new Set();
  server.on("close", () => { for (const close of live) close(); });

  async function forward(req, downstream, head) {
    const websocket = head !== undefined;
    const input = authorizationInput(req);
    const target = await resolve(input);
    validate(target);
    if (downstream.destroyed) return;
    let stopped = false;
    let renewTimer;
    let expiryTimer;
    let upstreamSocket;
    let upstream;
    const lifetime = setTimeout(close, 55 * 60 * 1000);
    lifetime.unref();
    function close() {
      if (stopped) return;
      stopped = true;
      clearTimeout(renewTimer); clearTimeout(expiryTimer); clearTimeout(lifetime);
      live.delete(close);
      upstream?.destroy(); upstreamSocket?.destroy(); downstream.destroy();
    }
    function guard(authorized) {
      clearTimeout(expiryTimer);
      const remaining = authorized.validUntil - Date.now();
      if (remaining <= 0) { close(); return; }
      expiryTimer = setTimeout(close, remaining);
      expiryTimer.unref();
      renewTimer = setTimeout(async () => {
        try {
          const next = await resolve(input);
          validate(next);
          if (!sameAuthority(target, next)) throw new Error("authority_changed");
          if (!stopped) guard(next);
        } catch { close(); }
      }, Math.min(5000, Math.max(1, remaining / 2)));
      renewTimer.unref();
    }
    live.add(close);
    downstream.once("close", close);
    downstream.once("error", close);
    req.once("aborted", close);
    req.once("error", close);
    guard(target);
    const headers = cleanHeaders(req.headers);
    for (const name of Object.keys(headers)) {
      if (name.startsWith("x-forwarded-") || name === "forwarded" || name === "x-serverless-authorization") delete headers[name];
    }
    headers.host = input.host;
    headers["x-forwarded-proto"] = "https";
    headers["x-forwarded-host"] = input.host;
    if (websocket) { headers.connection = "Upgrade"; headers.upgrade = "websocket"; }
    upstream = request({hostname: target.address, port: target.port, path: req.url, method: req.method, headers});
    upstream.on("error", () => {
      if (!websocket && !downstream.headersSent) downstream.writeHead(502, {"Cache-Control": "no-store"});
      close();
    });
    upstream.on("response", (response) => {
      if (websocket) { response.destroy(); close(); return; }
      downstream.writeHead(response.statusCode, {...cleanHeaders(response.headers), "cache-control": "no-store"});
      response.on("error", close);
      response.pipe(downstream);
    });
    upstream.on("upgrade", (response, socket, upstreamHead) => {
      if (!websocket || stopped) { socket.destroy(); return; }
      upstreamSocket = socket;
      const responseHeaders = cleanHeaders(response.headers);
      responseHeaders.connection = "Upgrade";
      responseHeaders.upgrade = "websocket";
      downstream.write("HTTP/1.1 101 Switching Protocols\r\n" + Object.entries(responseHeaders)
          .flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(v => `${key}: ${v}\r\n`)).join("") + "\r\n");
      if (upstreamHead.length) downstream.write(upstreamHead);
      if (head.length) socket.write(head);
      socket.on("error", close); socket.once("close", close);
      socket.pipe(downstream); downstream.pipe(socket);
    });
    if (websocket) upstream.end();
    else req.pipe(upstream);
  }
  return server;
}
function deny(response) {
  if (response.destroyed) return;
  if (typeof response.writeHead === "function") {
    response.writeHead(404, {"Cache-Control": "no-store"}); response.end();
  } else response.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}
module.exports = {createGateway, authorizationInput, validateTarget};
