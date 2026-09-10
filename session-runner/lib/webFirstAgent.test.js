"use strict";

const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const http = require("node:http");
const test = require("node:test");
const WebSocket = require("ws");
const {WebSocketServer} = WebSocket;
const {createWebFirstAgentGateway} = require("./webFirstAgent");
const {createWebSocketUpgradeRouter} = require("./webSocketUpgrade");

function adapterStub() {
  const events = new EventEmitter();
  const requests = [];
  return {
    requests,
    on(event, listener) {
      events.on(event, listener);
      return () => events.off(event, listener);
    },
    async connect() {
      const identity = {
        protocol: "mapache-pi-web-first/1",
        runtime: "pi-tui-extension",
        sessionGeneration: 1,
        piSession: "pi-session-1",
        adapter: "gate-a-0.1.0",
        package: {name: "pi-goal-x", version: "0.31.2"},
      };
      events.emit("handshake", identity);
      return identity;
    },
    async request(operation, payload, options) {
      requests.push({operation, payload, options});
      if (operation === "pause" || operation === "dialog_answer") {
        const error = new Error("web_first_adapter_operation_unsupported");
        error.code = "web_first_adapter_operation_unsupported";
        throw error;
      }
      return {accepted: true, requestId: options.requestId};
    },
    emitEvent(event) {
      events.emit("event", event);
    },
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

function nextMessage(socket) {
  if (socket.queue.length) return Promise.resolve(socket.queue.shift());
  return new Promise((resolve, reject) => socket.waiters.push({resolve, reject}));
}

function openSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/agent?access=valid`);
    socket.queue = [];
    socket.waiters = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      const waiter = socket.waiters.shift();
      if (waiter) waiter.resolve(message);
      else socket.queue.push(message);
    });
    socket.on("error", (error) => {
      while (socket.waiters.length) socket.waiters.shift().reject(error);
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function nextType(socket, type) {
  while (true) {
    const message = await nextMessage(socket);
    if (message.type === type) return message;
  }
}

test("authenticates /agent, acquires one controller, admits one prompt, and replays uncertainty", async () => {
  const adapter = adapterStub();
  const gateway = createWebFirstAgentGateway({
    adapter,
    config: {webFirstEnabled: true, webFirstHeartbeatMs: 10_000},
    terminalSession: {ensureForAgent: async () => {}},
  });
  await gateway.initialize();
  const httpServer = http.createServer();
  const terminalWss = new WebSocketServer({noServer: true});
  const browserWss = new WebSocketServer({noServer: true});
  httpServer.on("upgrade", createWebSocketUpgradeRouter({
    agentWss: gateway.server,
    terminalWss,
    browserWss,
    hasAgentAccess: () => true,
    hasBrowserAccess: () => true,
  }));
  const port = await listen(httpServer);
  let socket;
  try {
    socket = await openSocket(port);
    assert.deepEqual(await nextType(socket, "status"), {type: "status", status: "awaiting_hello", protocolVersion: 1});
    socket.send(JSON.stringify({type: "hello", clientId: "tab-1", surface: "web"}));
    const hello = await nextType(socket, "hello");
    assert.ok(hello.resumptionSecret);
    const base = {
      protocolVersion: 1,
      runtimeId: hello.runtimeId,
      executionEpoch: hello.executionEpoch,
      sessionGeneration: hello.sessionGeneration,
      controlEpoch: hello.snapshot.control.controlEpoch,
    };

    socket.send(JSON.stringify({...base, type: "control_acquire", commandId: "control-1", payload: {surface: "web"}}));
    const acquired = await nextType(socket, "result");
    assert.equal(acquired.ok, true);
    const controlEpoch = acquired.control.controlEpoch;
    const prompt = {...base, controlEpoch, type: "prompt", commandId: "command-1", payload: {message: "hello"}};
    socket.send(JSON.stringify(prompt));
    const accepted = await nextType(socket, "result");
    assert.equal(accepted.accepted, true);
    assert.equal(adapter.requests.filter((request) => request.operation === "prompt").length, 1);

    socket.send(JSON.stringify(prompt));
    const duplicate = await nextType(socket, "result");
    assert.equal(duplicate.duplicate, true);
    assert.equal(adapter.requests.filter((request) => request.operation === "prompt").length, 1);

    adapter.emitEvent({event: "agent_settled", rootRequestId: "command-1", sessionGeneration: 1, piSession: "pi-session-1"});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await gateway.snapshot()).operations.find((operation) => operation.commandId === "command-1").outcome, "unknown");
  } finally {
    socket?.close();
    gateway.close();
    terminalWss.close();
    browserWss.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("rejects malformed commands and keeps unsupported Gate A operations explicit", async () => {
  const adapter = adapterStub();
  const gateway = createWebFirstAgentGateway({adapter, config: {webFirstEnabled: true}, terminalSession: {ensureForAgent: async () => {}}});
  await gateway.initialize();
  const httpServer = http.createServer();
  const terminalWss = new WebSocketServer({noServer: true});
  const browserWss = new WebSocketServer({noServer: true});
  httpServer.on("upgrade", createWebSocketUpgradeRouter({agentWss: gateway.server, terminalWss, browserWss, hasAgentAccess: () => true, hasBrowserAccess: () => true}));
  const port = await listen(httpServer);
  let socket;
  try {
    socket = await openSocket(port);
    await nextType(socket, "status");
    socket.send(JSON.stringify({type: "hello", clientId: "tab-1"}));
    const hello = await nextType(socket, "hello");
    socket.send(JSON.stringify({
      protocolVersion: 1,
      runtimeId: hello.runtimeId,
      executionEpoch: hello.executionEpoch,
      sessionGeneration: hello.sessionGeneration,
      controlEpoch: hello.snapshot.control.controlEpoch,
      commandId: "bad-1",
      type: "unknown",
      payload: {},
    }));
    assert.equal((await nextType(socket, "error")).code, "unknown_command_type");
  } finally {
    socket?.close();
    gateway.close();
    terminalWss.close();
    browserWss.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
