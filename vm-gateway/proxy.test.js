"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {once} = require("node:events");
const {WebSocketServer, WebSocket} = require("ws");
const {createGateway, validateTarget} = require("./proxy");

async function fixture(t, resolve) {
  let requests = 0;
  const upstream = http.createServer((req, res) => {
    requests++;
    if (req.url.startsWith("/stream")) { res.writeHead(200); res.write("started"); return; }
    if (req.method === "PUT") { req.pipe(res); return; }
    res.end(JSON.stringify({url: req.url, host: req.headers.host, forwarded: req.headers["x-forwarded-host"]}));
  });
  const ws = new WebSocketServer({server: upstream});
  ws.on("connection", (socket) => socket.on("message", (data) => socket.send(data)));
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const target = {address: "10.90.0.12", port: 8080, sessionId: "session", bootId: "boot", generation: 1};
  const gateway = createGateway({resolve: async input => {
    if (input.host !== "fixture.example.com" || input.token !== "valid") throw new Error("denied");
    const result = {...target, validUntil: Date.now() + 400};
    return resolve ? resolve(input, result) : result;
  }, request: options => http.request({...options, hostname: "127.0.0.1", port: upstream.address().port})});
  gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
  t.after(() => {
    gateway.close(); gateway.closeAllConnections();
    for (const client of ws.clients) client.terminate();
    ws.close(); upstream.close(); upstream.closeAllConnections();
  });
  return {port: gateway.address().port, target, count: () => requests};
}

function request(f, path, {method = "GET", token = "valid", body, headers = {}} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({hostname: "127.0.0.1", port: f.port, path, method,
      headers: {host: "fixture.example.com", cookie: `mapache_access=${token}`, ...headers}}, res => {
      const chunks = []; res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers}));
      res.on("error", reject);
    });
    req.on("error", reject); req.end(body);
  });
}

test("HTTP streams payloads, preserves paths and replaces untrusted forwarded headers", async t => {
  const f = await fixture(t);
  const response = await request(f, "/preview?a=1", {headers: {"x-forwarded-host": "attacker.example"}});
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {url: "/preview?a=1", host: "fixture.example.com", forwarded: "fixture.example.com"});
  const body = Buffer.alloc(2 * 1024 * 1024, 123);
  const uploaded = await request(f, "/upload", {method: "PUT", body});
  assert.deepEqual(uploaded.body, body);
  assert.equal(uploaded.headers["cache-control"], "no-store");
});

test("denied and guessed hosts never connect to upstream", async t => {
  const f = await fixture(t);
  assert.equal((await request(f, "/agent", {token: "wrong"})).status, 404);
  assert.equal((await request(f, "/agent", {headers: {host: "foreign.example.com"}})).status, 404);
  assert.equal(f.count(), 0);
});

test("WebSocket relays binary frames and closes on generation replacement", async t => {
  const f = await fixture(t);
  const socket = new WebSocket(`ws://127.0.0.1:${f.port}/shell?mapache_access=valid`, {headers: {host: "fixture.example.com"}});
  t.after(() => socket.terminate());
  await once(socket, "open");
  socket.send(Buffer.from([0, 1, 255]));
  const [data] = await once(socket, "message");
  assert.deepEqual(data, Buffer.from([0, 1, 255]));
  const closed = once(socket, "close");
  f.target.generation++;
  await closed;
});

test("stream closes by lease deadline even if subsequent authorization hangs", async t => {
  let calls = 0;
  const f = await fixture(t, (_input, target) => ++calls === 1 ? target : new Promise(() => {}));
  const start = Date.now();
  await new Promise((resolve, reject) => {
    http.get({hostname: "127.0.0.1", port: f.port, path: "/stream", headers: {host: "fixture.example.com", cookie: "mapache_access=valid"}}, res => {
      res.resume(); res.once("close", resolve);
    }).on("error", reject);
  });
  assert.ok(Date.now() - start < 1500);
  assert.equal(calls, 2);
});

test("proxy independently rejects metadata, loopback and unbounded authorization", () => {
  const valid = {address: "10.90.0.12", port: 8080, sessionId: "session", bootId: "boot", generation: 1, validUntil: Date.now() + 10000};
  validateTarget(valid);
  for (const override of [{address: "169.254.169.254"}, {address: "127.0.0.1"}, {port: 22}, {validUntil: Date.now() + 999999}]) {
    assert.throws(() => validateTarget({...valid, ...override}));
  }
});
