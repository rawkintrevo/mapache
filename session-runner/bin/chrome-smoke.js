#!/usr/bin/env node

"use strict";

const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const {spawn} = require("child_process");
const {WebSocket} = require("ws");

const display = process.env.CHROME_SMOKE_DISPLAY || ":98";
const cdpPort = Number(process.env.CHROME_SMOKE_CDP_PORT || 19222);
const vncPort = Number(process.env.CHROME_SMOKE_VNC_PORT || 15900);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "mapache-chrome-smoke-"));
const children = [];

async function main() {
  const steps = {};
  let localServer;
  let browser;
  let browserVersion;
  try {
    localServer = await startLocalServer();
    start("Xvfb", [display, "-screen", "0", "1280x900x24", "-ac", "-nolisten", "tcp"]);
    await waitForFile(displaySocketPath());
    start("openbox", [], {DISPLAY: display});
    start("tint2", [], {DISPLAY: display});
    start("x11vnc", [
      "-display", display,
      "-localhost",
      "-rfbport", String(vncPort),
      "-forever",
      "-shared",
      "-nopw",
    ], {DISPLAY: display});
    browser = await launchBrowser();
    const version = await waitForJson(`http://127.0.0.1:${cdpPort}/json/version`);
    browserVersion = String(version.Browser || "unknown").slice(0, 120);
    if (!version.webSocketDebuggerUrl) throw new Error("CDP websocket endpoint missing");
    await waitForTcpPort(vncPort);
    steps.runtime = {ok: true, browser: browserVersion, cdpPort, vncPort};

    const client = await connectCdp(version.webSocketDebuggerUrl);
    try {
      const pageUrl = `http://127.0.0.1:${localServer.port}/`;
      const mainTarget = await createTarget(client, pageUrl);
      const popupTarget = await createTarget(client, `${pageUrl}?popup=1`);
      const targets = await client.send("Target.getTargets");
      const pageCount = (targets.result.targetInfos || []).filter((target) => target.type === "page").length;
      if (pageCount < 2) throw new Error(`expected_two_pages:${pageCount}`);
      steps.windows = {ok: true, pageCount};

      const seeded = await evaluateWithRetry(client, mainTarget,
          "document.cookie = 'mapacheSmoke=ok; Max-Age=3600; Path=/'; " +
          "localStorage.setItem('mapacheSmoke', 'ok'); " +
          "document.title = 'Mapache Chrome smoke'; " +
          "({cookie: document.cookie, storage: localStorage.getItem('mapacheSmoke')})");
      if (seeded.cookie !== "mapacheSmoke=ok" || seeded.storage !== "ok") {
        throw new Error("profile_seed_failed");
      }
      steps.profile = {ok: true, storage: "cookie_and_local_storage_seeded"};

      await client.send("Target.closeTarget", {targetId: popupTarget});
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await closeBrowser(client);
    } finally {
      client.close();
    }

    await stopProcess(browser);
    removeChild(browser);
    browser = null;
    const profileEntries = fs.readdirSync(profileDir);
    if (!profileEntries.length) throw new Error("profile_directory_empty_after_shutdown");
    steps.shutdown = {ok: true, profileFilesCreated: profileEntries.length};

    console.log(JSON.stringify({ok: true, browser: browserVersion, cdpPort, vncPort, steps}));
  } catch (error) {
    steps.failure = {ok: false, error: error.message || String(error)};
    console.error(JSON.stringify({ok: false, browser: browserVersion || null, cdpPort, vncPort, steps}));
    process.exitCode = 1;
  } finally {
    if (browser) await stopProcess(browser);
    for (const child of children.reverse()) await stopProcess(child);
    if (localServer) await closeServer(localServer.server);
    fs.rmSync(profileDir, {recursive: true, force: true});
    const displayNumber = display.match(/^:(\d+)$/);
    if (displayNumber) fs.rmSync(`/tmp/.X${displayNumber[1]}-lock`, {force: true});
  }
}

function start(command, args, extraEnv = {}, options = {}) {
  const child = spawn(command, args, {
    env: {...process.env, ...extraEnv},
    detached: Boolean(options.detached),
    stdio: "ignore",
  });
  child.detached = Boolean(options.detached);
  child.once("error", (error) => {
    child.spawnError = error;
  });
  children.push(child);
  return child;
}

async function launchBrowser() {
  const browser = start("chromium", [
    `--user-data-dir=${profileDir}`,
    `--display=${display}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
    "--window-size=1280,900",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "about:blank",
  ], {DISPLAY: display}, {detached: true});
  await waitForJson(`http://127.0.0.1:${cdpPort}/json/version`);
  return browser;
}

function startLocalServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>Mapache Chrome smoke</title><p>smoke</p>");
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({server, port: server.address().port});
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function removeChild(child) {
  const index = children.indexOf(child);
  if (index >= 0) children.splice(index, 1);
}

function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(forceTimer);
      clearTimeout(deadlineTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => killChild(child, "SIGKILL"), 2_000);
    const deadlineTimer = setTimeout(finish, 5_000);
    child.once("exit", finish);
    killChild(child, "SIGTERM");
  });
}

function killChild(child, signal) {
  try {
    if (child.detached && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error && error.code !== "ESRCH") throw error;
  }
}

async function createTarget(client, url) {
  const response = await client.send("Target.createTarget", {url});
  if (!response.result || !response.result.targetId) throw new Error("target_create_failed");
  return response.result.targetId;
}

async function evaluateWithRetry(client, targetId, expression) {
  const deadline = Date.now() + 5_000;
  let lastError;
  while (Date.now() < deadline) {
    let targetClient;
    try {
      const target = await findTarget(targetId);
      targetClient = await connectCdp(target.webSocketDebuggerUrl);
      const response = await targetClient.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      const result = response.result && response.result.result;
      if (result && result.value !== undefined) return result.value;
      lastError = new Error("evaluation_did_not_return_a_value");
    } catch (error) {
      lastError = error;
    } finally {
      if (targetClient) targetClient.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`CDP evaluation failed: ${lastError && lastError.message || "timeout"}`);
}

async function findTarget(targetId) {
  const targets = await waitForJson(`http://127.0.0.1:${cdpPort}/json/list`);
  const target = targets.find((entry) => entry.id === targetId);
  if (!target || !target.webSocketDebuggerUrl) throw new Error("target_websocket_unavailable");
  return target;
}

async function closeBrowser(client) {
  await Promise.race([
    client.send("Browser.close").catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    const client = {
      send(method, params = {}, sessionId) {
        return new Promise((resolveSend, rejectSend) => {
          const id = nextId++;
          pending.set(id, {resolve: resolveSend, reject: rejectSend});
          socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
        });
      },
      close() {
        for (const entry of pending.values()) entry.reject(new Error("CDP client closed"));
        pending.clear();
        socket.close();
      },
    };
    socket.once("open", () => resolve(client));
    socket.once("error", reject);
    socket.on("message", (message) => {
      let payload;
      try {
        payload = JSON.parse(String(message));
      } catch (error) {
        return;
      }
      if (!payload.id || !pending.has(payload.id)) return;
      const entry = pending.get(payload.id);
      pending.delete(payload.id);
      if (payload.error) entry.reject(new Error(payload.error.message || "CDP command failed"));
      else entry.resolve(payload);
    });
  });
}

async function waitForJson(url) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Chrome smoke CDP readiness failed: ${lastError && lastError.message || "timeout"}`);
}

async function waitForTcpPort(port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await connectTcpPort(port);
      return;
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("VNC smoke port timeout");
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`desktop_display_timeout:${filePath}`);
}

function displaySocketPath() {
  const displayNumber = display.match(/^:(\d+)$/);
  return displayNumber ? `/tmp/.X11-unix/X${displayNumber[1]}` : "";
}

function connectTcpPort(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({host: "127.0.0.1", port});
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
