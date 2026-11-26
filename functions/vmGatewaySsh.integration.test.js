"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const net = require("node:net");
const {Server, utils} = require("ssh2");
const {generateKeyMaterial} = require("./remoteHost.service");
const {sshPrivateKey} = require("./remoteHost.connection");
const {createSshTransportPool} = require("../vm-gateway/sshTransport");

test("real SSH gateway authenticates a converted registered key and relays only the guest target", {timeout: 15000}, async (t) => {
  const createSshTransport = createSshTransportPool({idleMs: 20});
  const hostKeys = utils.generateKeyPairSync("ed25519");
  const hostBlob = utils.parseKey(hostKeys.public).getPublicSSH();
  const material = generateKeyMaterial();
  const appKey = utils.parseKey(material.publicKey);
  const peers = new Set();
  let forwarded;
  const server = new Server({hostKeys: [hostKeys.private]}, (client) => {
    peers.add(client);
    client.on("error", () => {});
    client.on("close", () => peers.delete(client));
    client.on("authentication", (context) => {
      if (context.method !== "publickey" || context.username !== "mapache-vm" ||
          !context.key.data.equals(appKey.getPublicSSH()) ||
          context.signature && appKey.verify(context.blob, context.signature) !== true) return context.reject();
      context.accept();
    });
    client.on("tcpip", (accept, reject, info) => {
      forwarded = {host: info.destIP, port: info.destPort};
      const channel = accept();
      channel.on("data", (data) => channel.end(Buffer.concat([Buffer.from("relayed:"), data])));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const peer of peers) peer.end();
    await new Promise((resolve) => server.close(resolve));
  });
  // Loopback is confined to this in-process SSH server; production route
  // validation separately rejects loopback destinations.
  const transport = await createSshTransport({sshAddress: "127.0.0.1", sshPort: server.address().port,
    sshUsername: "mapache-vm", privateKey: sshPrivateKey(material.privateKey),
    hostKeyFingerprint: `SHA256/${crypto.createHash("sha256").update(hostBlob).digest("base64").replace(/=+$/, "")}`,
    guestAddress: "192.168.250.42", guestPort: 8787});
  t.after(() => transport.close());
  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(transport.port, transport.hostname);
    let output = "";
    socket.setTimeout(5000, () => socket.destroy(new Error("relay timed out")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write("probe"));
    socket.on("data", (data) => { output += data; });
    socket.on("close", () => resolve(output));
  });
  assert.equal(reply, "relayed:probe");
  assert.deepEqual(forwarded, {host: "192.168.250.42", port: 8787});
});
