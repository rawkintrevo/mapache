"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {EventEmitter} = require("node:events");
const {createChromeDesktopService} = require("./chromeDesktop");

function config(overrides = {}) {
  return {
    chromeEnabled: true,
    chromeDisplay: ":99",
    chromeCdpHost: "127.0.0.1",
    chromeCdpPort: 9222,
    chromeProfileDir: "/tmp/mapache-chrome-profile",
    chromeViewport: {width: 1440, height: 1000},
    chromeVncPort: 5900,
    ...overrides,
  };
}

test("starts the desktop stack in order and binds browser services to loopback", async () => {
  const calls = [];
  const children = [];
  const service = createChromeDesktopService(config(), {
    spawn: (command, args, options) => {
      calls.push({command, args, options});
      const child = new EventEmitter();
      child.pid = children.length + 1;
      child.kill = () => calls.push({command, signal: "SIGTERM"});
      children.push(child);
      return child;
    },
    fs: {promises: {
      mkdir: async () => {},
      rm: async () => {},
    }},
  });

  await service.start();
  assert.deepEqual(calls.slice(0, 5).map((call) => call.command), [
    "Xvfb", "openbox", "tint2", "chromium", "x11vnc",
  ]);
  const chromium = calls.find((call) => call.command === "chromium");
  assert.ok(chromium.args.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(chromium.args.includes("--remote-debugging-port=9222"));
  const vnc = calls.find((call) => call.command === "x11vnc");
  assert.ok(vnc.args.includes("-localhost"));
  assert.equal(service.status().state, "running");

  await service.stop();
  assert.deepEqual(calls.slice(-5).map((call) => call.command), [
    "x11vnc", "chromium", "tint2", "openbox", "Xvfb",
  ]);
});

test("restarts one isolated Chromium crash and then reports later failures", async () => {
  const children = [];
  const service = createChromeDesktopService(config(), {
    spawn: (command) => {
      const child = new EventEmitter();
      child.pid = children.length + 1;
      child.kill = () => {};
      children.push({command, child});
      return child;
    },
    fs: {promises: {mkdir: async () => {}, rm: async () => {}}},
  });

  await service.start();
  const firstBrowser = children.find((entry) => entry.command === "chromium").child;
  firstBrowser.emit("exit", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(service.status().browserRestartAttempts, 1);
  assert.equal(children.filter((entry) => entry.command === "chromium").length, 2);

  children.filter((entry) => entry.command === "chromium")[1].child.emit("exit", 1, null);
  assert.equal(service.status().state, "failed");
  await service.stop();
});
