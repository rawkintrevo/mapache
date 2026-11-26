"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const {Server, utils} = require("ssh2");
const {connectRemoteHost, sshPrivateKey} = require("./remoteHost.connection");
const {generateKeyMaterial} = require("./remoteHost.service");

test("real SSH handshake pins keys, authenticates existing PKCS8 keys, and runs bounded helper commands", async (t) => {
  const serverKeys = utils.generateKeyPairSync("ed25519");
  const serverPublic = utils.parseKey(serverKeys.public).getPublicSSH();
  const fingerprint = `SHA256/${crypto.createHash("sha256").update(serverPublic).digest("base64").replace(/=+$/, "")}`;
  const appKeys = generateKeyMaterial();
  const appPublic = utils.parseKey(appKeys.publicKey);
  assert.deepEqual(utils.parseKey(sshPrivateKey(appKeys.privateKey)).getPublicSSH(), appPublic.getPublicSSH());
  let authAttempts = 0;
  let replyMode = "normal";
  const commands = [];
  const peers = new Set();
  const server = new Server({hostKeys: [serverKeys.private]}, (client) => {
    peers.add(client);
    client.on("error", () => {});
    client.on("close", () => peers.delete(client));
    client.on("authentication", (context) => {
      authAttempts++;
      if (context.method !== "publickey" || context.username !== "mapache-vm" ||
          !context.key.data.equals(appPublic.getPublicSSH()) ||
          (context.signature && appPublic.verify(context.blob, context.signature) !== true)) return context.reject();
      context.accept();
    });
    client.on("ready", () => client.on("session", (accept) => {
      accept().on("exec", (accept, reject, info) => {
        commands.push(info.command);
        const stream = accept();
        if (replyMode === "hang") return;
        if (replyMode === "invalid") { stream.end("not json"); return; }
        const result = {version: "1", network: "mapache-vm", ready: replyMode !== "incomplete", ...(info.command.endsWith("capacity") ?
          {cpuCount: 20, memoryBytes: 64 * 1024 ** 3, freeDiskBytes: 100 * 1024 ** 3} : {virsh: ""})};
        stream.write(JSON.stringify(result));
        stream.exit(0);
        stream.end();
      });
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const peer of peers) peer.end();
    await new Promise((resolve) => server.close(resolve));
  });
  const request = {host: {address: "unused.invalid", port: server.address().port, managedUsername: "mapache-vm"},
    addresses: ["127.0.0.1"], privateKey: appKeys.privateKey};
  const discovery = await connectRemoteHost(request);
  assert.equal(discovery.hostKeyFingerprint, fingerprint);
  assert.equal(authAttempts, 0, "unconfirmed hosts must not receive authentication");
  request.host.hostKeyFingerprint = "SHA256/incorrect";
  await assert.rejects(connectRemoteHost(request), /remote_host_key_mismatch/);
  assert.equal(authAttempts, 0);
  request.host.hostKeyFingerprint = fingerprint;
  const result = await connectRemoteHost(request);
  assert.equal(result.capacity.cpuCount, 20);
  assert.deepEqual(commands, ["mapache-vm status", "mapache-vm capacity"]);
  replyMode = "incomplete";
  await assert.rejects(connectRemoteHost(request), /remote_host_setup_incomplete/);
  replyMode = "invalid";
  await assert.rejects(connectRemoteHost(request), /remote_host_helper_/);
  replyMode = "hang";
  await assert.rejects(connectRemoteHost({...request, timeoutMs: 300}), /remote_host_unreachable/);
});
