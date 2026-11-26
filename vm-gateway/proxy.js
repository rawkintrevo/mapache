"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const {promisify} = require("node:util");
const {execFile, spawn} = require("node:child_process");

const execFileAsync = promisify(execFile);
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const ACCESS_QUERY = "mapache_access";
const MAX_TOKEN_BYTES = 8192;
const MAX_LIFETIME_MS = 55 * 60 * 1000;

function createGateway({resolve, request = http.request, transportFactory = createSshTransport} = {}) {
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
    if (downstream.destroyed) return;

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
      if (websocket || stopped) return response.destroy();
      downstream.writeHead(response.statusCode || 502, {...cleanHeaders(response.headers), "cache-control": "no-store"});
      response.on("error", close);
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
  return {
    host,
    path: parsed.pathname,
    forwardPath: `${parsed.pathname}${parsed.search}`,
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
  headers.origin = `https://${headers.host}`;
  headers.cookie = `mapache_access=${encodeURIComponent(token)}`;
  if (shutdownToken && requestPath === "/runner/health") headers["x-shutdown-token"] = shutdownToken;
  if (websocket) {
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
  }
  return headers;
}

async function createSshTransport(target, dependencies = {}) {
  const directory = await fs.mkdtemp(`${os.tmpdir()}/mapache-vm-gateway-`);
  const keyPath = `${directory}/id_ed25519`;
  const knownHostsPath = `${directory}/known_hosts`;
  try {
    await fs.writeFile(keyPath, target.privateKey, {mode: 0o600});
    const knownHosts = await pinnedKnownHosts(target, dependencies);
    await fs.writeFile(knownHostsPath, knownHosts, {mode: 0o600});
    const sshSpawn = dependencies.spawn || spawn;
    const server = net.createServer((socket) => {
      const child = sshSpawn("ssh", [
        "-i", keyPath,
        "-p", String(target.sshPort),
        "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-o", `UserKnownHostsFile=${knownHostsPath}`,
        "-o", "ConnectTimeout=10",
        "-W", `${target.guestAddress}:${target.guestPort}`,
        `${target.sshUsername}@${target.sshAddress}`,
      ], {stdio: ["pipe", "pipe", "pipe"]});
      child.stderr?.resume?.();
      child.stdout?.pipe(socket);
      socket.pipe(child.stdin);
      const finish = () => {
        socket.destroy();
        child.kill?.("SIGTERM");
      };
      socket.once("close", finish);
      child.once("close", () => socket.destroy());
      child.once("error", finish);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    return {
      hostname: "127.0.0.1",
      port: address.port,
      close: () => {
        server.close();
        void fs.rm(directory, {recursive: true, force: true});
      },
    };
  } catch (error) {
    await fs.rm(directory, {recursive: true, force: true});
    throw error;
  }
}

async function pinnedKnownHosts(target, dependencies = {}) {
  const exec = dependencies.execFileAsync || execFileAsync;
  const {stdout} = await exec("ssh-keyscan", ["-T", "10", "-p", String(target.sshPort), target.sshAddress], {
    timeout: 15_000,
    maxBuffer: 256 * 1024,
  });
  const lines = String(stdout).split(/\r?\n/).filter((line) => line && !line.startsWith("#") && /\s(?:ssh-ed25519|ecdsa-sha2-nistp256)\s/.test(line));
  if (!lines.length) throw new Error("remote_host_unreachable");
  const fingerprintDirectory = await fs.mkdtemp(`${os.tmpdir()}/mapache-vm-key-`);
  const fingerprintPath = `${fingerprintDirectory}/host_key`;
  try {
    await fs.writeFile(fingerprintPath, `${lines[0]}\n`, {mode: 0o600});
    const fingerprint = await exec("ssh-keygen", ["-lf", fingerprintPath, "-E", "sha256"], {maxBuffer: 64 * 1024});
    const match = String(fingerprint.stdout || "").match(/SHA256:[A-Za-z0-9+/=]+/);
    const normalized = match ? match[0].replace(/^SHA256:/, "SHA256/") : "";
    if (normalized !== target.hostKeyFingerprint) throw new Error("remote_host_key_mismatch");
    return `${lines.join("\n")}\n`;
  } finally {
    await fs.rm(fingerprintDirectory, {recursive: true, force: true});
  }
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
      !isGuestAddress(target.guestAddress) || Number(target.guestPort) !== 8787 ||
      typeof target.privateKey !== "string" || target.privateKey.length < 64 || target.privateKey.length > 16 * 1024 ||
      !/^SHA256\/[A-Za-z0-9+/=_-]{8,}$/.test(String(target.hostKeyFingerprint || ""))) throw new Error("invalid_target");
}

function sameAuthority(a, b) {
  const keys = a?.transport === "ssh" ? ["transport", "sshAddress", "sshPort", "sshUsername", "guestAddress", "guestPort", "sessionId", "generation", "bootId"] :
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
  createSshTransport,
  sameAuthority,
  validateTarget,
};
