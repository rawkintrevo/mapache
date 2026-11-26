"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const {once} = require("node:events");
const {WebSocketServer, WebSocket} = require("ws");
const {createGateway, authorizationInput, sameAuthority, validateTarget, pinnedKnownHosts} = require("./proxy");

test("known_hosts contains only the confirmed Ed25519 key regardless of scan ordering", async () => {
  function key() {
    const publicKey = crypto.generateKeyPairSync("ed25519").publicKey.export({type: "spki", format: "der"}).subarray(-32);
    const blob = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), publicKey]);
    return {encoded: blob.toString("base64"), fingerprint: `SHA256/${crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`};
  }
  const pinned = key();
  const other = key();
  const target = {sshAddress: "home.example.com", sshPort: 2222, hostKeyFingerprint: pinned.fingerprint};
  const dependencies = {execFileAsync: async (program, args) => {
    assert.equal(program, "ssh-keyscan");
    assert.equal(args[args.indexOf("-t") + 1], "ed25519");
    return {stdout: `home.example.com ssh-ed25519 ${other.encoded}\nignored-host ssh-ed25519 ${pinned.encoded}\n`};
  }};
  assert.equal(await pinnedKnownHosts(target, dependencies), `[home.example.com]:2222 ssh-ed25519 ${pinned.encoded}\n`);
  await assert.rejects(pinnedKnownHosts({...target, hostKeyFingerprint: "SHA256/wrong"}, dependencies), /key_mismatch/);
  await assert.rejects(pinnedKnownHosts(target, {execFileAsync: async () => ({stdout: "host ssh-ed25519 AAAA\n"})}), /key_mismatch/);
});

async function fixture(t, resolveOverride) {
  let requests = 0;
  const upstream = http.createServer((req, res) => {
    requests++;
    if (req.url.startsWith("/agent/stream")) {
      res.writeHead(200);
      res.write("started");
      return;
    }
    if (req.method === "PUT") return req.pipe(res);
    res.end(JSON.stringify({url: req.url, host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie}));
  });
  const ws = new WebSocketServer({server: upstream});
  ws.on("connection", (socket) => socket.on("message", (data) => socket.send(data)));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const target = {
    transport: "ssh", sshAddress: "home.example.com", sshPort: 22, sshUsername: "mapache",
    hostKeyFingerprint: "SHA256/abcdefghijklmno", privateKey: "x".repeat(128),
    guestAddress: "192.168.250.12", guestPort: 8787,
    sessionId: "session", generation: 1, bootId: "boot", validUntil: Date.now() + 400,
  };
  const gateway = createGateway({
    resolve: async (input) => {
      if (input.host !== "gateway.example.com" || input.token !== "valid") throw new Error("denied");
      const result = {...target, validUntil: Date.now() + 400};
      return resolveOverride ? resolveOverride(input, result) : result;
    },
    transportFactory: async () => ({hostname: "127.0.0.1", port: upstream.address().port, close: () => {}}),
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(() => {
    gateway.close();
    for (const client of ws.clients) client.terminate();
    ws.close();
    upstream.close();
  });
  return {port: gateway.address().port, target, count: () => requests};
}

function request(f, path, {method = "GET", token = "valid", body, headers = {}} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({hostname: "127.0.0.1", port: f.port, path, method,
      headers: {host: "gateway.example.com", cookie: `mapache_access=${token}`, ...headers}}, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers}));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("SSH relay streams HTTP and strips browser authority from the guest request", async (t) => {
  const f = await fixture(t);
  const response = await request(f, "/agent/?mapache_access=valid&x=1", {headers: {
    origin: "https://gateway.example.com",
    "x-forwarded-host": "attacker.example",
  }});
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    url: "/agent/?x=1",
    host: "192.168.250.12:8787",
    origin: "https://192.168.250.12:8787",
    cookie: "mapache_access=valid",
  });
  const body = Buffer.alloc(2 * 1024 * 1024, 123);
  const uploaded = await request(f, "/agent/upload", {method: "PUT", body});
  assert.deepEqual(uploaded.body, body);
  assert.equal(uploaded.headers["cache-control"], "no-store");
});

test("denied and guessed hosts never connect to the guest", async (t) => {
  const f = await fixture(t);
  assert.equal((await request(f, "/agent/", {token: "wrong"})).status, 404);
  assert.equal((await request(f, "/agent/", {headers: {host: "foreign.example.com"}})).status, 404);
  assert.equal(f.count(), 0);
});

test("WebSocket frames relay and close when generation authority changes", async (t) => {
  const f = await fixture(t);
  const socket = new WebSocket(`ws://127.0.0.1:${f.port}/agent/ws?mapache_access=valid`, {
    headers: {host: "gateway.example.com", origin: "https://gateway.example.com"},
  });
  t.after(() => socket.terminate());
  await once(socket, "open");
  socket.send(Buffer.from([0, 1, 255]));
  const [data] = await once(socket, "message");
  assert.deepEqual(data, Buffer.from([0, 1, 255]));
  const closed = once(socket, "close");
  f.target.generation++;
  await closed;
});

test("authorization renewal closes a stream when the resolver hangs", async (t) => {
  let calls = 0;
  const f = await fixture(t, (_input, target) => ++calls === 1 ? target : new Promise(() => {}));
  const start = Date.now();
  await new Promise((resolve, reject) => {
    http.get({hostname: "127.0.0.1", port: f.port, path: "/agent/stream", headers: {
      host: "gateway.example.com", cookie: "mapache_access=valid",
    }}, (res) => {
      res.resume();
      res.once("close", resolve);
    }).on("error", reject);
  });
  assert.ok(Date.now() - start < 1500);
  assert.equal(calls, 2);
});

test("target validation rejects arbitrary forwarding and auth parsing removes the token", () => {
  const valid = {transport: "ssh", sshAddress: "home.example.com", sshPort: 22, sshUsername: "mapache",
    hostKeyFingerprint: "SHA256/abcdefghijklmno", privateKey: "x".repeat(128), guestAddress: "192.168.250.12",
    guestPort: 8787, sessionId: "session", bootId: "boot", generation: 1, validUntil: Date.now() + 10000};
  validateTarget(valid);
  for (const override of [{guestAddress: "169.254.169.254"}, {sshAddress: "127.0.0.1"}, {guestPort: 22}, {validUntil: Date.now() + 999999}]) {
    assert.throws(() => validateTarget({...valid, ...override}));
  }
  const input = authorizationInput({headers: {host: "gateway.example.com", cookie: "mapache_access=valid"}, url: "/agent/?mapache_access=other&x=1"});
  assert.equal(input.token, "other");
  assert.equal(input.forwardPath, "/agent/?x=1");
  assert.equal(sameAuthority(valid, {...valid, privateKey: "different"}), true);
  assert.equal(sameAuthority(valid, {...valid, hostKeyFingerprint: "SHA256/changed-key"}), false);
});
