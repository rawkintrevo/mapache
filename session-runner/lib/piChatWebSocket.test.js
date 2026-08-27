"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const WebSocket = require("ws");
const {WebSocketServer} = WebSocket;
const {createPiChatWebSocket, MAX_PROMPT_BYTES, parseClientMessage} = require("./piChatWebSocket");
const {createWebSocketUpgradeRouter} = require("./webSocketUpgrade");

function transcriptStub() {
  let listener = null;
  return {
    subscribe(next) {
      listener = next;
      next({type: "snapshot", messages: [{id: "u1", role: "user", markdown: "hello", createdAt: null}]});
      return () => {
        if (listener === next) listener = null;
      };
    },
    emit(event) {
      listener?.(event);
    },
    stop() {},
  };
}

function supportedConfig(overrides = {}) {
  return {
    harnessId: "pi",
    runnerCapabilities: {chat: true},
    ...overrides,
  };
}

async function createServer({config = supportedConfig(), terminalSession = {writePrompt() {}}, transcript = transcriptStub()} = {}) {
  const httpServer = http.createServer();
  const terminalWss = new WebSocketServer({noServer: true});
  const browserWss = new WebSocketServer({noServer: true});
  const chat = createPiChatWebSocket({
    config,
    hasBrowserAccess: (request) => new URL(request.url, "http://localhost").searchParams.get("access") === "valid",
    terminalSession,
    transcriptService: transcript,
  });
  httpServer.on("upgrade", createWebSocketUpgradeRouter({
    terminalWss,
    browserWss,
    chatWss: chat.server,
    hasBrowserAccess: () => true,
    hasChatAccess: (request) => chat.supported && new URL(request.url, "http://localhost").searchParams.get("access") === "valid",
  }));
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  return {
    chat,
    httpServer,
    port: httpServer.address().port,
    close() {
      chat.close();
      terminalWss.close();
      browserWss.close();
      httpServer.close();
    },
  };
}

function nextMessage(socket) {
  if (socket.chatMessageQueue?.length) return Promise.resolve(socket.chatMessageQueue.shift());
  if (socket.chatMessageWaiters) {
    return new Promise((resolve, reject) => socket.chatMessageWaiters.push({resolve, reject}));
  }
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      cleanup();
      resolve(JSON.parse(data.toString()));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.once("message", onMessage);
    socket.once("error", onError);
  });
}

function openSocket(port, query = "?access=valid") {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat${query}`);
    socket.chatMessageQueue = [];
    socket.chatMessageWaiters = [];
    socket.on("message", (data) => {
      const waiter = socket.chatMessageWaiters.shift();
      if (waiter) waiter.resolve(JSON.parse(data.toString()));
      else socket.chatMessageQueue.push(JSON.parse(data.toString()));
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function rejectedSocket(port, query) {
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

test("validates Chat prompts without exposing internal details", () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({type: "prompt", clientId: " client-1 ", text: " hello\nworld "})), {
    ok: true,
    clientId: "client-1",
    text: "hello\nworld",
  });
  assert.equal(parseClientMessage("not-json").code, "invalid_message");
  assert.equal(parseClientMessage(JSON.stringify({type: "prompt", clientId: "id", text: "  "})).code, "invalid_prompt");
  assert.equal(parseClientMessage(JSON.stringify({type: "prompt", clientId: "id", text: "bad\u0000text"})).code, "invalid_prompt");
  assert.equal(parseClientMessage(JSON.stringify({type: "prompt", clientId: "id", text: "x".repeat(MAX_PROMPT_BYTES + 1)})).code, "prompt_too_large");
});

test("authenticates Chat, forwards one prompt, and relays safe protocol events", async () => {
  const transcript = transcriptStub();
  const writes = [];
  const runtime = await createServer({transcript, terminalSession: {writePrompt: (text) => writes.push(text)}});
  try {
    const socket = await openSocket(runtime.port);
    assert.deepEqual(await nextMessage(socket), {
      type: "snapshot",
      messages: [{id: "u1", role: "user", markdown: "hello", createdAt: null}],
    });

    socket.send(JSON.stringify({type: "prompt", clientId: "client-1", text: " build it "}));
    assert.deepEqual(await nextMessage(socket), {type: "prompt_ack", clientId: "client-1"});
    assert.deepEqual(await nextMessage(socket), {type: "status", status: "working"});
    assert.deepEqual(writes, ["build it"]);

    transcript.emit({type: "status", status: "waiting_for_transcript", privatePath: "/secret"});
    assert.deepEqual(await nextMessage(socket), {type: "status", status: "waiting_for_transcript"});
    transcript.emit({type: "message", message: {id: "a1", role: "assistant", markdown: "# done", createdAt: "now", raw: "hidden"}});
    assert.deepEqual(await nextMessage(socket), {
      type: "message",
      message: {id: "a1", role: "assistant", markdown: "# done", createdAt: "now"},
    });
    socket.close();
  } finally {
    runtime.close();
  }
});

test("rejects unauthorized and unsupported Chat connections", async () => {
  const unauthorized = await createServer();
  try {
    assert.equal(await rejectedSocket(unauthorized.port, ""), 404);
  } finally {
    unauthorized.close();
  }

  const unsupported = await createServer({config: supportedConfig({harnessId: "codex"})});
  try {
    assert.equal(await rejectedSocket(unsupported.port, "?access=valid"), 404);
  } finally {
    unsupported.close();
  }
});

test("does not acknowledge a prompt when the PTY bridge fails", async () => {
  const runtime = await createServer({terminalSession: {writePrompt: () => { throw new Error("private"); }}});
  try {
    const socket = await openSocket(runtime.port);
    await nextMessage(socket);
    socket.send(JSON.stringify({type: "prompt", clientId: "client-1", text: "hello"}));
    assert.deepEqual(await nextMessage(socket), {type: "error", code: "prompt_failed"});
    socket.close();
  } finally {
    runtime.close();
  }
});
