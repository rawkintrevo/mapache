#!/usr/bin/env node

"use strict";

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const {spawn} = require("child_process");

const display = process.env.CHROME_SMOKE_DISPLAY || ":98";
const cdpPort = Number(process.env.CHROME_SMOKE_CDP_PORT || 19222);
const vncPort = Number(process.env.CHROME_SMOKE_VNC_PORT || 15900);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "mapache-chrome-smoke-"));
const children = [];

async function main() {
  try {
    start("Xvfb", [display, "-screen", "0", "1280x900x24", "-ac", "-nolisten", "tcp"]);
    start("openbox", [], {DISPLAY: display});
    start("tint2", [], {DISPLAY: display});
    start("chromium", [
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
    ], {DISPLAY: display});
    start("x11vnc", [
      "-display", display,
      "-localhost",
      "-rfbport", String(vncPort),
      "-forever",
      "-shared",
      "-nopw",
    ], {DISPLAY: display});

    const version = await waitForJson(`http://127.0.0.1:${cdpPort}/json/version`);
    if (!version.webSocketDebuggerUrl) throw new Error("CDP websocket endpoint missing");
    await waitForTcpPort(vncPort);
    console.log(JSON.stringify({ok: true, browser: String(version.Browser || "unknown").slice(0, 120), cdpPort, vncPort}));
  } finally {
    for (const child of children.reverse()) {
      if (typeof child.kill === "function") child.kill("SIGTERM");
    }
    fs.rmSync(profileDir, {recursive: true, force: true});
    const displayNumber = display.match(/^:(\d+)$/);
    if (displayNumber) fs.rmSync(`/tmp/.X${displayNumber[1]}-lock`, {force: true});
  }
}

function start(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    env: {...process.env, ...extraEnv},
    stdio: "ignore",
  });
  children.push(child);
  return child;
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
