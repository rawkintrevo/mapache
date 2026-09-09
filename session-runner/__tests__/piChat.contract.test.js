"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const WebSocket = require("ws");
const {WebSocketServer} = WebSocket;
const {createPiChatTranscriptService} = require("../lib/piChat.service");
const {createPiChatWebSocket} = require("../lib/piChatWebSocket");
const {createWebSocketUpgradeRouter} = require("../lib/webSocketUpgrade");

function record({id, parentId, role, content}) {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-27T14:00:00.000Z",
    message: {role, content},
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

function nextMessage(socket) {
  if (socket.chatMessageQueue.length) return Promise.resolve(socket.chatMessageQueue.shift());
  return new Promise((resolve, reject) => socket.chatMessageWaiters.push({resolve, reject}));
}

function openSocket(port, query = "?access=valid") {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat${query}`);
    socket.chatMessageQueue = [];
    socket.chatMessageWaiters = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      const waiter = socket.chatMessageWaiters.shift();
      if (waiter) waiter.resolve(message);
      else socket.chatMessageQueue.push(message);
    });
    socket.on("error", (error) => {
      while (socket.chatMessageWaiters.length) socket.chatMessageWaiters.shift().reject(error);
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function rejectSocket(port, query = "") {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat${query}`);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once("open", () => reject(new Error("unauthorized Chat WebSocket unexpectedly opened")));
    socket.once("error", () => {});
  });
}

async function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  await new Promise((resolve) => {
    socket.once("close", resolve);
    socket.close();
  });
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

test("exercises the local Pi Chat HTTP/WebSocket contract", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mapache-pi-chat-contract-"));
  const transcriptPath = path.join(root, "session.jsonl");
  await fsp.writeFile(transcriptPath, [
    record({id: "u0", role: "user", content: "start"}),
    record({id: "a0", parentId: "u0", role: "assistant", content: "# ready"}),
    "",
  ].join("\n"));

  const transcriptService = createPiChatTranscriptService({
    config: {piSessionDir: root},
    pollIntervalMs: 100000,
  });
  const writes = [];
  const terminalWss = new WebSocketServer({noServer: true});
  const browserWss = new WebSocketServer({noServer: true});
  const chat = createPiChatWebSocket({
    config: {harnessId: "pi", runnerCapabilities: {chat: true}},
    hasBrowserAccess: (request) => new URL(request.url, "http://localhost").searchParams.get("access") === "valid",
    terminalSession: {writePrompt: (text) => writes.push(text)},
    transcriptService,
  });
  const httpServer = http.createServer();
  httpServer.on("upgrade", createWebSocketUpgradeRouter({
    terminalWss,
    browserWss,
    chatWss: chat.server,
    hasBrowserAccess: () => true,
    hasChatAccess: (request) => chat.supported && new URL(request.url, "http://localhost").searchParams.get("access") === "valid",
  }));
  const port = await listen(httpServer);
  let socket;
  let reconnect;

  try {
    socket = await openSocket(port);
    assert.deepEqual(await nextMessage(socket), {type: "status", status: "waiting_for_transcript"});
    assert.deepEqual((await nextMessage(socket)).messages.map((message) => message.id), ["u0", "a0"]);
    assert.deepEqual(await nextMessage(socket), {type: "status", status: "ready"});

    socket.send(JSON.stringify({type: "prompt", clientId: "client-1", text: " inspect the app "}));
    assert.deepEqual(await nextMessage(socket), {type: "prompt_ack", clientId: "client-1"});
    assert.deepEqual(await nextMessage(socket), {type: "status", status: "working"});
    assert.deepEqual(writes, ["inspect the app"]);

    await fsp.appendFile(transcriptPath, [
      record({id: "u1", parentId: "a0", role: "user", content: "inspect the app"}),
      record({id: "a1", parentId: "u1", role: "assistant", content: "The app is healthy."}),
      "",
    ].join("\n"));
    await transcriptService.poll();
    assert.deepEqual((await nextMessage(socket)).message, {
      id: "u1",
      role: "user",
      markdown: "inspect the app",
      createdAt: "2026-08-27T14:00:00.000Z",
    });
    assert.deepEqual((await nextMessage(socket)).message, {
      id: "a1",
      role: "assistant",
      markdown: "The app is healthy.",
      createdAt: "2026-08-27T14:00:00.000Z",
    });

    await closeSocket(socket);
    socket = null;
    reconnect = await openSocket(port);
    const replay = await nextMessage(reconnect);
    assert.equal(replay.type, "snapshot");
    assert.deepEqual(replay.messages.map((message) => message.id), ["u0", "a0", "u1", "a1"]);
    assert.equal(new Set(replay.messages.map((message) => message.id)).size, replay.messages.length);
    assert.equal(await rejectSocket(port), 404);
    assert.deepEqual(writes, ["inspect the app"]);
  } finally {
    await closeSocket(socket);
    await closeSocket(reconnect);
    chat.close();
    await closeServer(terminalWss);
    await closeServer(browserWss);
    await closeServer(httpServer);
    await fsp.rm(root, {recursive: true, force: true});
  }
});
