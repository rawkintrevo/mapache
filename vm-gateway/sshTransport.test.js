"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const net = require("node:net");
const {once} = require("node:events");
const {Server, utils} = require("ssh2");
const {createSshTransportPool} = require("./sshTransport");

async function fixture(t) {
  const key = crypto.generateKeyPairSync("rsa", {modulusLength: 2048}).privateKey.export({type: "pkcs1", format: "pem"});
  let connections = 0;
  let authentications = 0;
  const clients = new Set();
  const server = new Server({hostKeys: [key]}, (client) => {
    connections++;
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (context) => { authentications++; context.accept(); });
    client.on("ready", () => client.on("tcpip", (accept, reject, info) => {
      assert.equal(info.destIP, "192.168.250.12");
      assert.equal(info.destPort, 8080);
      const stream = accept();
      stream.on("error", () => {});
      stream.on("data", (data) => stream.write(data));
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { for (const c of clients) c.end(); server.close(); });
  return {connections: () => connections, authentications: () => authentications, target: {
    sshAddress: "127.0.0.1", sshPort: server.address().port, sshUsername: "mapache-vm",
    privateKey: key, guestAddress: "192.168.250.12", guestPort: 8080,
    hostKeyFingerprint: "SHA256/" + crypto.createHash("sha256").update(utils.parseKey(key).getPublicSSH()).digest("base64").replace(/=+$/, ""),
  }};
}

async function echo(transport, message) {
  const socket = net.connect(transport.port, transport.hostname);
  try {
    await once(socket, "connect");
    socket.write(message);
    const [data] = await once(socket, "data");
    assert.equal(data.toString(), message);
  } finally { socket.destroy(); }
}

test("parallel asset transports share one pinned SSH handshake and close independently", async (t) => {
  const f = await fixture(t);
  const create = createSshTransportPool({idleMs: 20});
  const transports = await Promise.all(Array.from({length: 24}, (_, index) => create({
    ...f.target, privateKey: f.target.privateKey + "\n".repeat(index),
  })));
  t.after(() => transports.forEach((item) => item.close()));
  await Promise.all(transports.map((item, index) => echo(item, `asset-${index}`)));
  assert.equal(f.connections(), 1);
  transports[0].close();
  await echo(transports[1], "still-open");
  transports.forEach((item) => item.close());
});

test("changed host fingerprint is rejected before authentication and cannot reuse a trusted connection", async (t) => {
  const f = await fixture(t);
  const create = createSshTransportPool({idleMs: 20});
  const trusted = await create(f.target);
  t.after(() => trusted.close());
  const before = f.authentications();
  await assert.rejects(create({...f.target, hostKeyFingerprint: "SHA256/wrong"}));
  assert.equal(f.authentications(), before);
  await echo(trusted, "trusted-still-open");
});

test("transport key rotation and idle expiry require a new SSH connection", async (t) => {
  const f = await fixture(t);
  const create = createSshTransportPool({idleMs: 20});
  const first = await create(f.target);
  const rotatedKey = crypto.generateKeyPairSync("rsa", {modulusLength: 2048}).privateKey.export({type: "pkcs1", format: "pem"});
  const second = await create({...f.target, privateKey: rotatedKey});
  t.after(() => { first.close(); second.close(); });
  assert.equal(f.connections(), 2);
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const third = await create(f.target);
  t.after(() => third.close());
  assert.equal(f.connections(), 3);
  await echo(third, "reconnected");
});
