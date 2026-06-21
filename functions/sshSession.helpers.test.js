"use strict";

const assert = require("assert");
const {normalizeSshSessionPayload} = require("./sshSession.helpers");

const normalized = normalizeSshSessionPayload({
  sshTarget: {
    host: "dev.example.com",
    port: "2222",
    username: "developer",
    initialDirectory: "/home/developer/project",
    authMode: "certificate",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----",
    certificate: "ssh-ed25519-cert-v01@openssh.com AAAA user-cert",
    knownHosts: "dev.example.com ssh-ed25519 AAAAhost",
  },
});

assert.deepStrictEqual(normalized.public, {
  host: "dev.example.com",
  port: 2222,
  username: "developer",
  initialDirectory: "/home/developer/project",
  auth: {
    type: "openssh-user-certificate",
    hasCertificate: true,
    strictHostKeyChecking: true,
    hasKnownHosts: true,
  },
  fileBrowser: {
    scope: "initial-directory",
    root: "/home/developer/project",
  },
});
assert.ok(normalized.secrets.privateKey.includes("OPENSSH PRIVATE KEY"));
assert.ok(normalized.secrets.certificate.endsWith("\n"));
assert.strictEqual(normalized.secrets.authMode, "certificate");

const privateKeyOnly = normalizeSshSessionPayload({
  host: "dev.example.com",
  username: "developer",
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----",
});
assert.strictEqual(privateKeyOnly.public.auth.type, "private-key");
assert.strictEqual(privateKeyOnly.public.auth.hasCertificate, false);
assert.strictEqual(privateKeyOnly.secrets.certificate, "");
assert.strictEqual(privateKeyOnly.secrets.authMode, "private-key");

assert.throws(() => normalizeSshSessionPayload({sshTarget: {username: "developer"}}), /ssh_host_required/);
assert.throws(() => normalizeSshSessionPayload({
  host: "dev.example.com",
  username: "developer",
  privateKey: "key",
  port: 70000,
}), /invalid_ssh_port/);
assert.throws(() => normalizeSshSessionPayload({
  host: "dev.example.com",
  username: "developer",
  privateKey: "key",
  authMode: "certificate",
}), /ssh_certificate_required/);

console.log("ssh session helper tests passed");
