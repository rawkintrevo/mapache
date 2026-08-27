"use strict";

function createWebSocketUpgradeRouter({terminalWss, browserWss, chatWss, hasBrowserAccess, hasChatAccess} = {}) {
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
    if (pathname === "/chat") {
      if (!chatWss || typeof hasChatAccess !== "function" || !hasChatAccess(request)) {
        rejectUpgrade(socket);
        return;
      }
      handleUpgrade(chatWss, request, socket, head);
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
