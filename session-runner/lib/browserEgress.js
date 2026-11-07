"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {spawn} = require("node:child_process");
const net = require("node:net");

// Read once before child processes are started. Do not inherit credentials.
function takeBrowserEgressConfig(env = process.env) {
  const raw = env.MAPACHE_BROWSER_SSH_EGRESS;
  delete env.MAPACHE_BROWSER_SSH_EGRESS;
  if (!raw) return null;
  try {
    const config = JSON.parse(raw);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(config.host || "") ||
        !/^[a-z_][a-z0-9_-]{0,31}$/.test(config.user || "") ||
        !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
        !/^ssh-ed25519 [A-Za-z0-9+/]+={0,3}$/.test(config.hostKey || "") ||
        !String(config.privateKey || "").startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n")) throw new Error();
    return config;
  } catch {
    throw new Error("browser_egress_invalid_configuration");
  }
}

function browserProxyArgs(enabled) {
  return enabled ? [
    "--proxy-server=socks5://127.0.0.1:1080",
    "--proxy-bypass-list=localhost;127.0.0.1;[::1]",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ] : [];
}

function createBrowserEgress(config, deps = {}) {
  const files = deps.fs || fs;
  const spawnImpl = deps.spawn || spawn;
  const wait = deps.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const schedule = deps.setTimeout || setTimeout;
  const cancel = deps.clearTimeout || clearTimeout;
  const probe = deps.probe || probeSocks;
  let directory;
  let child;
  let retry;
  let stopping = true;
  let attempts = 0;
  let state = config ? "stopped" : "disabled";
  const args = () => [
    "-F", "/dev/null", "-N", "-T", "-D", "127.0.0.1:1080",
    "-i", path.join(directory, "key"), "-p", String(config.port),
    "-o", `UserKnownHostsFile=${path.join(directory, "known_hosts")}`,
    "-o", "GlobalKnownHostsFile=/dev/null", "-o", "StrictHostKeyChecking=yes",
    "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    "-o", "ForwardAgent=no", "-o", "ControlMaster=no", "-o", "ControlPath=none",
    `${config.user}@${config.host}`,
  ];

  function launch() {
    if (stopping) return;
    state = "connecting";
    let current;
    try { current = spawnImpl("ssh", args(), {stdio: "ignore"}); } catch { failed(); return; }
    child = current;
    let handled = false;
    const onExit = () => {
      if (handled) return;
      handled = true;
      if (child === current) child = null;
      if (!stopping) failed();
    };
    current.once("error", onExit);
    current.once("exit", onExit);
  }

  function failed() {
    state = "unavailable";
    if (stopping) return;
    retry = schedule(() => {retry = null; launch();}, Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)));
    retry?.unref?.();
  }

  async function start() {
    if (!config || !stopping) return;
    stopping = false;
    try {
      // Outside HOME/workspace/profile archives, private to this container.
      directory = await files.mkdtemp("/tmp/mapache-browser-egress-");
      await files.chmod(directory, 0o700);
      await files.writeFile(path.join(directory, "key"), config.privateKey, {mode: 0o600});
      const host = config.port === 22 ? config.host : `[${config.host}]:${config.port}`;
      await files.writeFile(path.join(directory, "known_hosts"), `${host} ${config.hostKey}\n`, {mode: 0o600});
      launch();
      for (let i = 0; i < 100; i++) {
        if (child && await probe()) {state = "ready"; return;}
        await wait(100);
      }
      throw new Error();
    } catch {
      await stop();
      throw new Error("browser_egress_start_failed");
    }
  }

  async function stop() {
    stopping = true;
    if (retry) cancel(retry);
    retry = null;
    if (child) {
      const current = child;
      child = null;
      current.kill("SIGTERM");
      // SSH normally exits immediately; bound cleanup of an unresponsive process.
      const timer = schedule(() => current.kill("SIGKILL"), 2000);
      timer?.unref?.();
      current.once("exit", () => cancel(timer));
    }
    if (directory) await files.rm(directory, {recursive: true, force: true});
    directory = null;
    state = config ? "stopped" : "disabled";
  }
  return {start, stop, status: () => ({enabled: Boolean(config), state})};
}

function probeSocks() {
  return new Promise((resolve) => {
    const socket = net.connect({host: "127.0.0.1", port: 1080});
    let done = false;
    const finish = (ok) => {if (!done) {done = true; socket.destroy(); resolve(ok);}};
    socket.setTimeout(500, () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(Buffer.from([5, 1, 0])));
    socket.on("data", (data) => finish(data[0] === 5 && data[1] === 0));
    socket.on("end", () => finish(false));
  });
}

module.exports = {takeBrowserEgressConfig, browserProxyArgs, createBrowserEgress};
