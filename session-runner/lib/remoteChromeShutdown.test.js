"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {EventEmitter, once} = require("node:events");
const http = require("node:http");
const {WebSocketServer} = require("ws");
const {closeRemoteChrome} = require("./remoteChromeShutdown");

test("guest shutdown requests a profile flush and waits for the browser to exit", async (t) => {
  const child = Object.assign(new EventEmitter(), {exitCode: null});
  const httpServer = http.createServer((req, res) => {
    assert.equal(req.url, "/json/version");
    res.end(JSON.stringify({webSocketDebuggerUrl: `ws://127.0.0.1:${httpServer.address().port}/devtools/browser/test`}));
  });
  const wsServer = new WebSocketServer({server: httpServer});
  let exited = false;
  wsServer.on("connection", (client) => client.once("message", (message) => {
    assert.equal(JSON.parse(message).method, "Browser.close");
    setImmediate(() => {
      exited = true;
      child.emit("exit", 0);
    });
  }));
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  t.after(() => { wsServer.close(); httpServer.close(); });
  await closeRemoteChrome(child, {chromeCdpPort: httpServer.address().port});
  assert.equal(exited, true);
});
