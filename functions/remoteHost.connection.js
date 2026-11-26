"use strict";

const crypto = require("node:crypto");
const {Client} = require("ssh2");
const {httpError} = require("./backendUtils.helpers");

// Earlier registrations stored PKCS8 Ed25519 keys. Preserve their public key
// while encoding the same seed in the format SSH clients accept.
function sshPrivateKey(value) {
  if (!String(value).includes("BEGIN PRIVATE KEY")) return value;
  const jwk = crypto.createPrivateKey(value).export({format: "jwk"});
  if (jwk.crv !== "Ed25519") throw httpError(502, "remote_host_key_invalid");
  const integer = (value) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
  const string = (value) => { const b = Buffer.from(value); return Buffer.concat([integer(b.length), b]); };
  const publicKey = Buffer.from(jwk.x, "base64url");
  const publicBlob = Buffer.concat([string("ssh-ed25519"), string(publicKey)]);
  const check = crypto.randomBytes(4);
  let secret = Buffer.concat([check, check, publicBlob,
    string(Buffer.concat([Buffer.from(jwk.d, "base64url"), publicKey])), string("")]);
  const padding = 8 - secret.length % 8;
  secret = Buffer.concat([secret, Buffer.from(Array.from({length: padding}, (_, index) => index + 1))]);
  const blob = Buffer.concat([Buffer.from("openssh-key-v1\0"), string("none"), string("none"),
    string(""), integer(1), string(publicBlob), string(secret)]);
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${blob.toString("base64").match(/.{1,70}/g).join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function command(client, text) {
  return new Promise((resolve, reject) => {
    client.exec(text, (error, stream) => {
      if (error) return reject(httpError(502, "remote_host_helper_failed"));
      let output = "";
      let bytes = 0;
      stream.on("data", (data) => {
        bytes += data.length;
        if (bytes > 128 * 1024) {
          reject(httpError(502, "remote_host_helper_invalid"));
          stream.destroy();
        } else output += data.toString();
      });
      // Never propagate command stderr (which may contain private host paths).
      stream.stderr.resume();
      stream.on("error", () => reject(httpError(502, "remote_host_helper_failed")));
      stream.on("close", (code) => {
        if (code !== 0) return reject(httpError(502, "remote_host_helper_failed"));
        try { resolve(JSON.parse(output)); } catch { reject(httpError(502, "remote_host_helper_invalid")); }
      });
    });
  });
}

function connectRemoteHost({host, addresses, privateKey, timeoutMs = 15000}) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let observed;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(httpError(504, "remote_host_unreachable")), timeoutMs);
    client.on("error", () => finish(httpError(502, "remote_host_unreachable")));
    client.on("close", () => finish(httpError(502, "remote_host_unreachable")));
    client.on("ready", async () => {
      try {
        const status = await command(client, "mapache-vm status");
        if (status.ready !== true) throw httpError(409, "remote_host_setup_incomplete");
        const capacity = await command(client, "mapache-vm capacity");
        if (status.version !== "1" || status.network !== "mapache-vm" ||
            capacity.version !== "1" || capacity.network !== "mapache-vm" ||
            ![capacity.cpuCount, capacity.memoryBytes, capacity.freeDiskBytes].every((n) => Number.isFinite(n) && n > 0)) {
          throw httpError(502, "remote_host_helper_invalid");
        }
        finish(null, {hostKeyFingerprint: observed, capacity});
      } catch (error) { finish(error); }
    });
    try {
      if (!addresses?.length) throw httpError(502, "remote_host_unreachable");
      client.connect({
        // Use the already validated IP, without a second DNS resolution.
        host: addresses[0], port: host.port, username: host.managedUsername,
        privateKey: sshPrivateKey(privateKey), readyTimeout: timeoutMs,
        algorithms: {serverHostKey: ["ssh-ed25519"]},
        hostVerifier: (key) => {
          observed = `SHA256/${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
          if (!host.hostKeyFingerprint) {
            finish(null, {hostKeyFingerprint: observed});
            return false;
          }
          if (host.hostKeyFingerprint !== observed) {
            finish(httpError(502, "remote_host_key_mismatch"));
            return false;
          }
          return true;
        },
      });
    } catch { finish(httpError(502, "remote_host_key_invalid")); }
  });
}

module.exports = {connectRemoteHost, sshPrivateKey};
