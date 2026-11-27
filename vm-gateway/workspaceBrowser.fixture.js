"use strict";

// Synthetic local-only targets for browser cookie/HTTP/WebSocket isolation QA.
// No cloud credentials, host transport, owner impersonation or real guest work.
const http = require("node:http");
const {once} = require("node:events");
const {WebSocketServer} = require("ws");
const {createGateway} = require("./proxy");

async function startFixture(port = 0) {
  const guests = new Map();
  for (const workspace of ["alpha", "beta"]) {
    const server = http.createServer((req, res) => {
      if (req.url === "/agent/") {
        res.setHeader("content-type", "text/html");
        return res.end('<html><head><link rel="icon" href="data:,"><script defer src="/agent/assets/app.js"></script></head><body><h1>Gateway isolation fixture</h1><pre id="result">Loading</pre></body></html>');
      }
      if (req.url === "/agent/assets/probe.css") {
        res.setHeader("content-type", "text/css");
        return res.end('body{background-image:url("/agent/assets/pixel.svg")}');
      }
      if (req.url === "/agent/assets/pixel.svg") {
        res.setHeader("content-type", "image/svg+xml");
        return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
      }
      if (req.url === "/agent/assets/app.js") {
        res.setHeader("content-type", "application/javascript");
        return res.end(`function preload(path){return "/agent/"+path}
        const style=document.createElement('link'); style.rel='stylesheet';
        style.href=preload('assets/probe.css'); document.head.appendChild(style);
        window.probe = async () => {
          const response = await fetch(new URL('identity', document.baseURI));
          const identity = await response.text();
          const url = new URL('ws', document.baseURI); url.protocol = 'ws:';
          const ws = new WebSocket(url);
          const echo = await new Promise((resolve, reject) => {
            setTimeout(() => reject(new Error('WebSocket timeout')), 3000);
            ws.onopen = () => ws.send('probe'); ws.onmessage = e => resolve(e.data); ws.onerror = reject;
          });
          ws.close();
          const result = {http: identity, websocket: echo, status: response.status};
          document.getElementById('result').textContent = JSON.stringify(result);
          return result;
        }; window.probe();`);
      }
      if (req.url === "/agent/identity") return res.end(workspace);
      res.writeHead(404); res.end();
    });
    const ws = new WebSocketServer({server});
    ws.on("connection", (socket) => socket.on("message", () => socket.send(workspace)));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    guests.set(workspace, {server, ws});
  }
  const gateway = createGateway({
    resolve: async (input) => {
      const workspace = input.path.split("/")[2];
      if (!guests.has(workspace) || input.token !== `fixture-${workspace}`) throw new Error("not_found");
      return {transport: "ssh", sshAddress: "fixture.example.com", sshPort: 22, sshUsername: "mapache",
        hostKeyFingerprint: "SHA256/fixture-key", privateKey: "x".repeat(128),
        guestAddress: "192.168.250.12", guestPort: 8080, sessionId: workspace,
        generation: 1, bootId: "fixture-boot", validUntil: Date.now() + 10000};
    },
    transportFactory: async (target) => ({hostname: "127.0.0.1",
      port: guests.get(target.sessionId).server.address().port, close: () => {}}),
  });
  gateway.listen(port, "127.0.0.1");
  await once(gateway, "listening");
  return {port: gateway.address().port, close: () => {
    gateway.close();
    for (const {server, ws} of guests.values()) {
      for (const client of ws.clients) client.terminate();
      ws.close(); server.close();
    }
  }};
}

module.exports = {startFixture};
if (require.main === module) {
  startFixture(Number(process.env.PORT || 18843)).then((fixture) => {
    console.log(`Workspace isolation fixture listening on 127.0.0.1:${fixture.port}`);
    process.on("SIGTERM", () => fixture.close());
  });
}
