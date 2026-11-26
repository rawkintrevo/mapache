"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const {Server, utils} = require("ssh2");
const {connectRemoteHost, runRemoteHostCommand, sshPrivateKey} = require("./remoteHost.connection");
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
  let receivedConfiguration;
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
        if (info.command.startsWith("mapache-vm configure ")) {
          let input = "";
          stream.on("data", (data) => { input += data.toString(); });
          stream.on("end", () => {
            receivedConfiguration = JSON.parse(input);
            stream.write(JSON.stringify({configured: true}));
            stream.exit(0); stream.end();
          });
          return;
        }
        if (replyMode === "hang") return;
        if (replyMode === "full") {
          stream.stderr.write("No space left on device: /private/host/path");
          stream.exit(1); stream.end(); return;
        }
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
  const operation = {...request, action: "inspect", guestName: "mapache-ws-test"};
  const authBefore = authAttempts;
  await assert.rejects(runRemoteHostCommand({...operation, host: {...request.host, hostKeyFingerprint: null}}), /remote_host_trust_incomplete/);
  await assert.rejects(runRemoteHostCommand({...operation, action: "bash"}), /remote_host_command_invalid/);
  await assert.rejects(runRemoteHostCommand({...operation, guestName: "mapache-ws-test; id"}), /remote_host_command_invalid/);
  assert.equal(authAttempts, authBefore);
  for (const action of ["inspect", "create", "start", "stop", "destroy", "capacity"]) {
    await runRemoteHostCommand({...operation, action});
    assert.equal(commands.at(-1), `mapache-vm ${action}${action === "capacity" ? "" : " mapache-ws-test"}`);
  }
  replyMode = "full";
  const configuration = {SESSION_ID: "private-session-value"};
  assert.deepEqual(await runRemoteHostCommand({...operation, action: "configure", configuration}), {configured: true});
  assert.deepEqual(receivedConfiguration, configuration);
  assert.equal(commands.some((value) => value.includes("private-session-value")), false);
  await assert.rejects(runRemoteHostCommand(operation), (error) => {
    assert.equal(error.publicMessage, "remote_vm_thin_disk_exhausted");
    assert.equal(error.message.includes("/private/"), false);
    return true;
  });
  replyMode = "incomplete";
  await assert.rejects(connectRemoteHost(request), /remote_host_setup_incomplete/);
  replyMode = "invalid";
  await assert.rejects(connectRemoteHost(request), /remote_host_helper_/);
  replyMode = "hang";
  await assert.rejects(connectRemoteHost({...request, timeoutMs: 300}), /remote_host_unreachable/);
});
