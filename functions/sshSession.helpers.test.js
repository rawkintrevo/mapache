"use strict";

const assert = require("assert");
const {normalizeSshSessionPayload} = require("./sshSession.helpers");

const normalized = normalizeSshSessionPayload({
  sshTarget: {
    host: "dev.example.com",
    port: "2222",
    username: "developer",
    initialDirectory: "/home/developer/project",
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

assert.throws(() => normalizeSshSessionPayload({sshTarget: {username: "developer"}}), /ssh_host_required/);
assert.throws(() => normalizeSshSessionPayload({
  host: "dev.example.com",
  username: "developer",
  privateKey: "key",
  certificate: "cert",
  port: 70000,
}), /invalid_ssh_port/);

console.log("ssh session helper tests passed");
