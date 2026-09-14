"use strict";

function createWebSocketUpgradeRouter({
  terminalWss,
  browserWss,
  agentWebSocket,
  metricsWss,
  shellWss,
  hasBrowserAccess,
  hasMetricsAccess,
  hasShellAccess,
} = {}) {
  if (!terminalWss || !browserWss) {
    throw new Error("WebSocket upgrade routing requires terminal and browser servers.");
  }

  return function routeWebSocketUpgrade(request, socket, head) {
    const pathname = requestPathname(request);
    if (pathname === "/terminal") {
      handleUpgrade(terminalWss, request, socket, head);
      return;
    }
    if (pathname === "/browser/vnc") {
      if (typeof hasBrowserAccess !== "function" || !hasBrowserAccess(request)) {
        rejectUpgrade(socket);
        return;
      }
      handleUpgrade(browserWss, request, socket, head);
      return;
    }
    if (pathname === "/agent/ws") {
      if (typeof agentWebSocket !== "function") {
        rejectUpgrade(socket);
        return;
      }
      agentWebSocket(request, socket, head);
      return;
    }
    if (pathname === "/metrics") {
      if (!metricsWss || typeof hasMetricsAccess !== "function" || !hasMetricsAccess(request)) {
        rejectUpgrade(socket);
        return;
      }
      handleUpgrade(metricsWss, request, socket, head);
      return;
    }
    if (pathname === "/shell") {
      if (!shellWss || typeof hasShellAccess !== "function" || !hasShellAccess(request)) {
        rejectUpgrade(socket);
        return;
      }
      handleUpgrade(shellWss, request, socket, head);
      return;
    }
    socket.destroy();
  };
}

function requestPathname(request) {
  try {
    return new URL(request && request.url || "/", "http://localhost").pathname;
  } catch (error) {
    return "";
  }
}

function handleUpgrade(webSocketServer, request, socket, head) {
  webSocketServer.handleUpgrade(request, socket, head, (client) => {
    webSocketServer.emit("connection", client, request);
  });
}

function rejectUpgrade(socket) {
  socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  socket.destroy();
}

module.exports = {
  createWebSocketUpgradeRouter,
  requestPathname,
};
