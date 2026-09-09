"use strict";

const {WebSocketServer, WebSocket} = require("ws");

function createResourceMetricsWebSocket({
  hasBrowserAccess,
  metricsService,
  WebSocketServerClass = WebSocketServer,
} = {}) {
  if (!metricsService || typeof metricsService.subscribe !== "function") {
    throw new Error("Resource metrics WebSocket requires a metrics service.");
  }

  const server = new WebSocketServerClass({noServer: true});
  const sockets = new Set();

  server.on("connection", (socket, request) => {
    if (typeof hasBrowserAccess !== "function" || !hasBrowserAccess(request)) {
      socket.close(1008, "unauthorized");
      return;
    }

    sockets.add(socket);
    const unsubscribe = metricsService.subscribe((event) => send(socket, event));
    socket.once("close", () => {
      sockets.delete(socket);
      unsubscribe();
    });
    socket.on("error", () => {});
  });

  return {
    server,
    close() {
      for (const socket of sockets) socket.close(1001, "runner_shutdown");
      sockets.clear();
      metricsService.close?.();
      server.close();
    },
  };
}

function send(socket, event) {
  if (socket.readyState !== WebSocket.OPEN || !event || typeof event !== "object") return;
  socket.send(JSON.stringify(event));
}

module.exports = {
  createResourceMetricsWebSocket,
};
