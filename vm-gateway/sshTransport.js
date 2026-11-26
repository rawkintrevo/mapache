"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const {Client, utils} = require("ssh2");

function createSshTransportPool({idleMs = 30_000} = {}) {
  const entries = new Map();
  return async function createSshTransport(target) {
    const key = utils.parseKey(target.privateKey);
    if (!key || typeof key.getPublicSSH !== "function") throw new Error("remote_host_key_invalid");
    const identity = JSON.stringify([target.sshAddress, target.sshPort, target.sshUsername,
      target.hostKeyFingerprint, crypto.createHash("sha256").update(key.getPublicSSH()).digest("hex")]);
    let entry = entries.get(identity);
    if (!entry) {
      const client = new Client();
      entry = {client, refs: 0, timer: null};
      entries.set(identity, entry);
      entry.ready = new Promise((resolve, reject) => {
        client.once("ready", resolve);
        client.on("error", reject);
        client.once("close", () => {
          if (entries.get(identity) === entry) entries.delete(identity);
          clearTimeout(entry.timer);
          reject(new Error("remote_host_connection_closed"));
        });
        client.connect({
          host: target.sshAddress, port: target.sshPort, username: target.sshUsername,
          privateKey: target.privateKey, readyTimeout: 10_000,
          keepaliveInterval: 5000, keepaliveCountMax: 2,
          hostHash: "sha256",
          hostVerifier: (hash) => `SHA256/${Buffer.from(hash, "hex").toString("base64").replace(/=+$/, "")}` === target.hostKeyFingerprint,
        });
      });
    }
    clearTimeout(entry.timer);
    entry.refs++;
    let released = false;
    const sockets = new Set();
    let server;
    const close = () => {
      if (released) return;
      released = true;
      server?.close();
      for (const socket of sockets) socket.destroy();
      if (--entry.refs === 0) {
        entry.timer = setTimeout(() => {
          if (entries.get(identity) === entry) entries.delete(identity);
          entry.client.end();
        }, idleMs);
        entry.timer.unref();
      }
    };
    try {
      await entry.ready;
      server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => socket.destroy());
        socket.once("close", () => sockets.delete(socket));
        const forwarded = (error, channel) => {
          if (error) return socket.destroy();
          if (released || socket.destroyed) return channel.destroy();
          channel.on("error", () => socket.destroy());
          channel.once("close", () => socket.destroy());
          socket.once("close", () => channel.destroy());
          socket.pipe(channel).pipe(socket);
        };
        try {
          entry.client.forwardOut("127.0.0.1", 0, target.guestAddress, target.guestPort, forwarded);
        } catch {
          socket.destroy();
        }
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      return {hostname: "127.0.0.1", port: server.address().port, close};
    } catch (error) {
      if (entries.get(identity) === entry) entries.delete(identity);
      close();
      throw error;
    }
  };
}

module.exports = {createSshTransportPool};
