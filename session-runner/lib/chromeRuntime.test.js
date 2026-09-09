"use strict";

const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const test = require("node:test");
const {createChromeRuntime, probeTcpPort, sanitizeBrowserError} = require("./chromeRuntime");

test("VNC TCP probes report a successful connection", async () => {
  const socket = new EventEmitter();
  let destroyed = false;
  socket.destroy = () => {
    destroyed = true;
  };
  socket.setTimeout = () => {};

  const result = probeTcpPort({
    connect: (options) => {
      assert.deepEqual(options, {host: "127.0.0.1", port: 5900});
      process.nextTick(() => socket.emit("connect"));
      return socket;
    },
  }, "127.0.0.1", 5900);

  assert.equal(await result, true);
  assert.equal(destroyed, true);
});

test("non-Chrome runtimes stay disabled and do not start a desktop", async () => {
  let starts = 0;
  const runtime = createChromeRuntime({runnerCapabilities: {chrome: false}}, {
    desktop: {start: async () => starts += 1, stop: async () => {}, status: () => ({})},
  });

  assert.deepEqual(runtime.status(), {
    enabled: false,
    state: "disabled",
    ready: false,
    startedAt: null,
    error: null,
    display: null,
    viewport: null,
    cdp: null,
    vnc: null,
    noVnc: null,
    processes: null,
  });
  await runtime.start();
  assert.equal(starts, 0);
});

test("Chrome becomes ready only after the loopback CDP version endpoint responds", async () => {
  let starts = 0;
  let probes = 0;
  const runtime = createChromeRuntime({
    chromeEnabled: true,
    chromeCdpHost: "127.0.0.1",
    chromeCdpPort: 9222,
    chromeStartupTimeoutMs: 1000,
    chromeDisplay: ":99",
    chromeViewport: {width: 1440, height: 1000},
    chromeVncHost: "127.0.0.1",
    chromeVncPort: 5900,
    chromeNoVncPort: 6080,
  }, {
    desktop: {
      start: async () => starts += 1,
      stop: async () => {},
      status: () => ({
        state: "running",
        ready: true,
        xvfb: "running",
        windowManager: "running",
        taskbar: "running",
        chromium: "running",
        vnc: "running",
      }),
    },
    probeVnc: async () => true,
    fetch: async () => {
      probes += 1;
      if (probes === 1) return {ok: false, status: 503};
      return {ok: true, json: async () => ({webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/test"})};
    },
    delay: async () => {},
  });

  await runtime.start();
  assert.equal(starts, 1);
  assert.equal(probes, 2);
  assert.equal(runtime.status().state, "ready");
  assert.equal(runtime.status().cdp.ready, true);
  assert.equal(runtime.status().processes.chromium, "running");
});

test("Chrome is not ready when VNC is absent even if CDP responds", async () => {
  const runtime = createChromeRuntime({
    chromeEnabled: true,
    chromeCdpHost: "127.0.0.1",
    chromeCdpPort: 9222,
    chromeStartupTimeoutMs: 1,
  }, {
    desktop: {
      start: async () => {},
      stop: async () => {},
      status: () => ({
        state: "running",
        ready: true,
        xvfb: true,
        windowManager: true,
        taskbar: true,
        chromium: true,
        vnc: false,
      }),
    },
    fetch: async () => ({ok: true, json: async () => ({webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/test"})}),
    probeVnc: async () => false,
    delay: async () => {},
    now: (() => {
      let value = 0;
      return () => value += 2;
    })(),
  });

  await assert.rejects(runtime.start(), /Chrome desktop did not become ready/);
  assert.equal(runtime.status().ready, false);
  assert.equal(runtime.status().state, "failed");
  assert.equal(runtime.status().vnc.ready, false);
});

test("browser status leaves ready when a supervised desktop process exits", async () => {
  let currentStatus = {
    state: "running",
    ready: true,
    xvfb: true,
    windowManager: true,
    taskbar: true,
    chromium: true,
    vnc: true,
  };
  let listener;
  const runtime = createChromeRuntime({
    chromeEnabled: true,
    chromeCdpHost: "127.0.0.1",
    chromeCdpPort: 9222,
    chromeStartupTimeoutMs: 1000,
  }, {
    desktop: {
      start: async () => {},
      stop: async () => {},
      status: () => currentStatus,
      onStateChange: (callback) => {
        listener = callback;
        return () => {};
      },
    },
    fetch: async () => ({ok: true, json: async () => ({webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/test"})}),
    probeVnc: async () => true,
    delay: async () => {},
  });

  await runtime.start();
  assert.equal(runtime.status().ready, true);
  currentStatus = {...currentStatus, state: "degraded", ready: false, vnc: false};
  listener(currentStatus);
  assert.equal(runtime.status().state, "degraded");
  assert.equal(runtime.status().ready, false);
  assert.equal(runtime.status().vnc.ready, false);
});

test("startup failures become actionable and do not expose profile arguments", async () => {
  const runtime = createChromeRuntime({
    chromeEnabled: true,
    chromeCdpHost: "127.0.0.1",
    chromeCdpPort: 9222,
    chromeStartupTimeoutMs: 1,
  }, {
    desktop: {
      start: async () => {},
      stop: async () => {},
      status: () => ({
        state: "running",
        ready: true,
        xvfb: true,
        windowManager: true,
        taskbar: true,
        chromium: true,
        vnc: true,
      }),
    },
    fetch: async () => { throw new Error("spawn failed --user-data-dir /var/lib/mapache/chrome/profile"); },
    probeVnc: async () => true,
    delay: async () => {},
  });

  await assert.rejects(runtime.start(), /Chrome did not become ready/);
  assert.equal(runtime.status().state, "failed");
  assert.doesNotMatch(runtime.status().error, /var\/lib\/mapache/);
  assert.equal(sanitizeBrowserError(new Error("--remote-debugging-port 9222")), "<redacted-argument>");
});
