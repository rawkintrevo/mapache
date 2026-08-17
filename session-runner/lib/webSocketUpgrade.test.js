"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const WebSocket = require("ws");
const {WebSocketServer} = WebSocket;
const {createWebSocketUpgradeRouter} = require("./webSocketUpgrade");

test("routes terminal and browser upgrades without path handlers racing", async (t) => {
  const server = http.createServer();
  const terminalWss = new WebSocketServer({noServer: true});
  const browserWss = new WebSocketServer({noServer: true});
  const hasBrowserAccess = (request) => {
    const url = new URL(request.url, "http://localhost");
    return url.searchParams.get("access") === "valid";
  };
  server.on("upgrade", createWebSocketUpgradeRouter({terminalWss, browserWss, hasBrowserAccess}));
  terminalWss.on("connection", (socket) => socket.send("terminal-ready"));
  browserWss.on("connection", (socket) => socket.send(Buffer.from("RFB 003.008\n")));

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    terminalWss.close();
    browserWss.close();
    server.close();
  });
  const {port} = server.address();

  assert.equal(await firstMessage(`ws://127.0.0.1:${port}/terminal`), "terminal-ready");
  assert.equal(
      await firstMessage(`ws://127.0.0.1:${port}/browser/vnc?access=valid`, ["binary"]),
      "RFB 003.008\n",
  );
  assert.equal(await rejectedStatus(`ws://127.0.0.1:${port}/browser/vnc`), 404);
});

function firstMessage(url, protocols) {
  return new Promise((resolve, reject) => {
    const socket = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    socket.once("message", (data) => {
      socket.close();
      resolve(Buffer.from(data).toString("utf8"));
    });
    socket.once("error", reject);
  });
}

function rejectedStatus(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once("open", () => reject(new Error("unauthorized WebSocket unexpectedly opened")));
    socket.once("error", () => {});
  });
}
