"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const WebSocket = require("ws");
const {WebSocketServer} = WebSocket;
const {createResourceMetricsWebSocket} = require("./resourceMetricsWebSocket");
const {createWebSocketUpgradeRouter} = require("./webSocketUpgrade");

function createMetricsService() {
  let listener = null;
  return {
    subscribe(next) {
      listener = next;
      return () => {
        if (listener === next) listener = null;
      };
    },
    emit(event) {
      listener?.(event);
    },
    close() {
      listener = null;
    },
  };
}

async function createServer() {
  const httpServer = http.createServer();
  const terminalWss = new WebSocketServer({noServer: true});
  const browserWss = new WebSocketServer({noServer: true});
  const metricsService = createMetricsService();
  const metrics = createResourceMetricsWebSocket({
    metricsService,
    hasBrowserAccess: (request) => new URL(request.url, "http://localhost").searchParams.get("access") === "valid",
  });
  httpServer.on("upgrade", createWebSocketUpgradeRouter({
    terminalWss,
    browserWss,
    metricsWss: metrics.server,
    hasBrowserAccess: () => true,
    hasMetricsAccess: (request) => new URL(request.url, "http://localhost").searchParams.get("access") === "valid",
  }));
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  return {
    httpServer,
    metrics,
    metricsService,
    port: httpServer.address().port,
    close() {
      metrics.close();
      terminalWss.close();
      browserWss.close();
      httpServer.close();
    },
  };
}

function openSocket(port, query = "?access=valid") {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/metrics${query}`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket) {
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

function rejectedSocket(port, query = "") {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/metrics${query}`);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once("open", () => reject(new Error("unauthorized metrics WebSocket unexpectedly opened")));
    socket.once("error", () => {});
  });
}

test("authenticates metrics clients and relays safe samples", async () => {
  const runtime = await createServer();
  try {
    const socket = await openSocket(runtime.port);
    const sample = {
      type: "metrics",
      sampledAt: 1700000000000,
      cpu: {percent: 42.5, limitCores: 2},
      memory: {usedBytes: 100, limitBytes: 200, percent: 50},
    };
    runtime.metricsService.emit(sample);
    assert.deepEqual(await nextMessage(socket), sample);
    socket.close();
  } finally {
    runtime.close();
  }
});

test("rejects unauthorized metrics connections", async () => {
  const runtime = await createServer();
  try {
    assert.equal(await rejectedSocket(runtime.port), 404);
  } finally {
    runtime.close();
  }
});
