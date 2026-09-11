"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const test = require("node:test");
const WebSocket = require("ws");
const {WebSocketServer} = WebSocket;
const {createAgentWebSocketGateway, AGENT_EXPIRED_CODE} = require("./agentWebSocketGateway");
const {createBrowserAccessVerifier} = require("./browserAccess");
const {createWebSocketUpgradeRouter} = require("./webSocketUpgrade");

function signedToken(secret, claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

test("proxies the pi-web-ui hello/snapshot exchange and preserves existing sockets", async (t) => {
  const secret = "agent-websocket-secret";
  const now = 1_700_000_000_000;
  const token = signedToken(secret, {
    aud: "agent",
    exp: now / 1000 + 60,
    gen: "7",
    sid: "session-1",
  });
  const verifier = createBrowserAccessVerifier({
    audience: "agent",
    generation: "7",
    now: () => now,
    requireAudience: true,
    requireGeneration: true,
    secret,
    sessionId: "session-1",
  });
  const upstreamServer = http.createServer();
  const upstreamWss = new WebSocketServer({noServer: true});
  const upstreamActivity = [];
  upstreamServer.on("upgrade", (request, socket, head) => {
    if (new URL(request.url, "http://localhost").pathname !== "/ws") {
      socket.destroy();
      return;
    }
    upstreamWss.handleUpgrade(request, socket, head, (client) => upstreamWss.emit("connection", client, request));
  });
  upstreamWss.on("connection", (socket, request) => {
    upstreamActivity.push({headers: request.headers, url: request.url});
    socket.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type !== "hello") return;
      socket.send(JSON.stringify({type: "ready"}));
      socket.send(JSON.stringify({type: "snapshot", state: {rev: 1, messages: []}}));
    });
  });
  await listen(upstreamServer);

  const server = http.createServer();
  const clientWss = new WebSocketServer({noServer: true});
  const terminalWss = new WebSocketServer({noServer: true});
  const browserWss = new WebSocketServer({noServer: true});
  const metricsWss = new WebSocketServer({noServer: true});
  const gateway = createAgentWebSocketGateway({
    accessVerifier: verifier,
    clientWss,
    getUpstreamHeaders: () => ({"x-pi-token": "private-upstream-token"}),
    upstreamPort: upstreamServer.address().port,
  });
  const hasExistingAccess = (request) => new URL(request.url, "http://localhost").searchParams.get("access") === "valid";
  server.on("upgrade", createWebSocketUpgradeRouter({
    agentWebSocket: gateway.handleUpgrade,
    browserWss,
    hasBrowserAccess: hasExistingAccess,
    hasMetricsAccess: hasExistingAccess,
    metricsWss,
    terminalWss,
  }));
  const existingMessages = [];
  terminalWss.on("connection", (socket) => {
    existingMessages.push("terminal");
    socket.send("terminal-ready");
  });
  metricsWss.on("connection", (socket) => {
    existingMessages.push("metrics");
    socket.send("metrics-ready");
  });
  await listen(server);
  const origin = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    for (const socket of clientWss.clients) socket.terminate();
    for (const socket of terminalWss.clients) socket.terminate();
    for (const socket of browserWss.clients) socket.terminate();
    for (const socket of metricsWss.clients) socket.terminate();
    clientWss.close();
    terminalWss.close();
    browserWss.close();
    metricsWss.close();
    server.close();
    for (const socket of upstreamWss.clients) socket.terminate();
    upstreamWss.close();
    upstreamServer.close();
  });

  assert.equal(await firstMessage(`ws://127.0.0.1:${server.address().port}/terminal`), "terminal-ready");
  assert.equal(await firstMessage(`ws://127.0.0.1:${server.address().port}/metrics?access=valid`), "metrics-ready");

  for (const claims of [
    {aud: "browser", exp: now / 1000 + 60, gen: "7", sid: "session-1"},
    {aud: "agent", exp: now / 1000 + 60, gen: "8", sid: "session-1"},
    {aud: "agent", exp: now / 1000 - 1, gen: "7", sid: "session-1"},
  ]) {
    const rejectedToken = signedToken(secret, claims);
    assert.equal(
        await rejectedStatus(`ws://127.0.0.1:${server.address().port}/agent/ws?mapache_access=${encodeURIComponent(rejectedToken)}`, origin),
        404,
    );
  }
  assert.equal(upstreamActivity.length, 0);

  const agent = await connect(
      `ws://127.0.0.1:${server.address().port}/agent/ws?mapache_access=${encodeURIComponent(token)}&client=1`,
      origin,
  );
  try {
    assert.equal(existingMessages.join(","), "terminal,metrics");
    agent.socket.send(JSON.stringify({type: "hello", clientId: "client-1"}));
    assert.deepEqual(await agent.next(), {type: "ready"});
    assert.deepEqual(await agent.next(), {type: "snapshot", state: {rev: 1, messages: []}});
    assert.equal(upstreamActivity.length, 1);
    assert.equal(upstreamActivity[0].url, "/ws?client=1");
    assert.equal(upstreamActivity[0].headers["x-pi-token"], "private-upstream-token");
    assert.equal(upstreamActivity[0].headers.cookie, undefined);
    assert.equal(upstreamActivity[0].headers.origin, undefined);
    assert.equal(upstreamActivity[0].headers.authorization, undefined);
  } finally {
    agent.socket.close();
    await onceClose(agent.socket);
  }

  assert.equal(await rejectedStatus(`ws://127.0.0.1:${server.address().port}/agent/ws?client=unauthorized`, origin), 404);
  assert.equal(upstreamActivity.length, 1);
  assert.equal(
      await rejectedStatus(`ws://127.0.0.1:${server.address().port}/agent/ws?mapache_access=${encodeURIComponent(token)}`, "https://foreign.example"),
      403,
  );
  assert.equal(upstreamActivity.length, 1);
});

test("closes both sides when the signed agent access expires", async (t) => {
  const secret = "agent-expiry-secret";
  const now = 1_700_000_000_000;
  const token = signedToken(secret, {aud: "agent", exp: now / 1000 + 60, gen: "7", sid: "session-1"});
  const verifier = createBrowserAccessVerifier({
    audience: "agent",
    generation: "7",
    now: () => now,
    requireAudience: true,
    requireGeneration: true,
    secret,
    sessionId: "session-1",
  });
  verifier.maxAgeMs = () => 35;
  const upstreamServer = new WebSocketServer({port: 0, host: "127.0.0.1"});
  let upstreamClosed = false;
  upstreamServer.on("connection", (socket) => socket.once("close", () => { upstreamClosed = true; }));
  await onceListening(upstreamServer);
  const server = http.createServer();
  const clientWss = new WebSocketServer({noServer: true});
  const gateway = createAgentWebSocketGateway({
    accessVerifier: verifier,
    clientWss,
    getUpstreamHeaders: () => ({"x-pi-token": "private-upstream-token"}),
    upstreamPort: upstreamServer.address().port,
  });
  server.on("upgrade", createWebSocketUpgradeRouter({
    agentWebSocket: gateway.handleUpgrade,
    browserWss: new WebSocketServer({noServer: true}),
    hasBrowserAccess: () => false,
    terminalWss: new WebSocketServer({noServer: true}),
  }));
  await listen(server);
  t.after(() => {
    for (const socket of clientWss.clients) socket.terminate();
    clientWss.close();
    server.close();
    for (const socket of upstreamServer.clients) socket.terminate();
    upstreamServer.close();
  });

  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/agent/ws?mapache_access=${encodeURIComponent(token)}`, {
    headers: {Origin: `http://127.0.0.1:${server.address().port}`},
  });
  const close = await onceClose(socket);
  assert.equal(close.code, AGENT_EXPIRED_CODE);
  await waitFor(() => upstreamClosed);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function onceListening(server) {
  return new Promise((resolve) => server.once("listening", resolve));
}

function connect(url, origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {headers: {Origin: origin}});
    const messages = [];
    const waiters = [];
    socket.on("message", (data) => {
      const waiter = waiters.shift();
      if (waiter) waiter(data);
      else messages.push(data);
    });
    socket.once("open", () => resolve({
      next: () => {
        if (messages.length) return parseMessage(messages.shift());
        return new Promise((messageResolve, messageReject) => {
          const timer = setTimeout(() => messageReject(new Error("timed out waiting for agent message")), 2000);
          waiters.push((data) => {
            clearTimeout(timer);
            try { messageResolve(parseMessage(data)); } catch (error) { messageReject(error); }
          });
        });
      },
      socket,
    }));
    socket.once("error", reject);
  });
}

function parseMessage(data) {
  return JSON.parse(data.toString());
}

function firstMessage(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("message", (data) => {
      socket.close();
      resolve(data.toString());
    });
    socket.once("error", reject);
  });
}

function rejectedStatus(url, origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {headers: {Origin: origin}});
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once("open", () => reject(new Error("unauthorized WebSocket unexpectedly opened")));
    socket.once("error", () => {});
  });
}

function onceClose(socket) {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve({code: socket._closeCode});
      return;
    }
    socket.once("close", (code, reason) => resolve({code, reason: reason.toString()}));
  });
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(predicate(), true);
}
