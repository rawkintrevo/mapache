"use strict";

const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {PassThrough} = require("node:stream");
const test = require("node:test");
const {createPiWebUiProcess} = require("./piWebUiProcess");

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    child.killed = true;
    child.emit("exit", signal === "SIGKILL" ? 137 : 0, signal);
    return true;
  };
  return child;
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-pi-web-ui-process-"));
  const runtimeRoot = path.join(root, "runtime");
  await fs.mkdir(path.join(runtimeRoot, "dist", "server"), {recursive: true});
  await fs.writeFile(path.join(runtimeRoot, "dist", "server", "index.js"), "// test runtime\n");
  const adapterRoot = path.join(root, "pi-mcp-adapter");
  await fs.mkdir(adapterRoot, {recursive: true});
  await fs.writeFile(path.join(adapterRoot, "package.json"), JSON.stringify({name: "pi-mcp-adapter", version: "2.32.1", pi: {extensions: ["./index.ts"]}}));
  await fs.writeFile(path.join(adapterRoot, "index.ts"), "// test adapter\n");
  return {
    root,
    config: {
      agentRuntimeEnabled: true,
      homeDir: path.join(root, "home"),
      piWebUiDataDir: path.join(root, "state", "ui"),
      piMcpAdapterPath: path.join(adapterRoot, "index.ts"),
      piMcpAdapterVersion: "2.32.1",
      piWebUiHealthIntervalMs: 1,
      piWebUiHost: "127.0.0.1",
      piWebUiPiDir: path.join(root, "state", "pi"),
      piWebUiPort: 8787,
      piWebUiRoot: runtimeRoot,
      piWebUiSessionDir: path.join(root, "state", "sessions"),
      piWebUiStartupTimeoutMs: 10,
      piWebUiStopTimeoutMs: 10,
      workspaceDir: path.join(root, "workspace"),
      workspaceGoogleApplicationCredentials: "",
    },
  };
}

function healthyFetch(body = {ok: true, engine: "pi", build: {packageVersion: "0.79.0"}}) {
  return async (_url, options) => {
    assert.equal(options.headers["x-pi-token"].length > 20, true);
    return {ok: true, status: 200, json: async () => body};
  };
}

test("starts one managed child, waits for local Pi health, and stops it", async () => {
  const {root, config} = await fixture();
  const child = fakeChild();
  const spawnCalls = [];
  const logs = [];
  try {
    const process = createPiWebUiProcess(config, {
      env: {PATH: "/usr/bin", GOOGLE_APPLICATION_CREDENTIALS: "/secret"},
      fetch: healthyFetch(),
      logger: {error: (message) => logs.push(message)},
      randomBytes: () => Buffer.alloc(32, 7),
      spawn: (command, args, options) => {
        spawnCalls.push({command, args, options});
        return child;
      },
    });

    const ready = await process.start();
    assert.equal(ready.state, "ready");
    assert.equal(ready.ready, true);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].args[0], path.join(config.piWebUiRoot, "dist", "server", "index.js"));
    assert.equal(spawnCalls[0].options.cwd, config.workspaceDir);
    assert.equal(spawnCalls[0].options.detached, true);
    assert.equal(spawnCalls[0].options.env.PI_WEB_HOST, "127.0.0.1");
    assert.equal(spawnCalls[0].options.env.PI_WEB_PORT, "8787");
    assert.equal(spawnCalls[0].options.env.PI_WEB_MANAGED, "1");
    assert.equal(spawnCalls[0].options.env.PI_WEB_MCP_ADAPTER_PATH, config.piMcpAdapterPath);
    assert.equal(spawnCalls[0].options.env.PI_WEB_ENGINE, "pi");
    assert.equal(spawnCalls[0].options.env.PI_WEB_TOKEN.length > 20, true);
    assert.equal(spawnCalls[0].options.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(JSON.stringify(ready).includes(spawnCalls[0].options.env.PI_WEB_TOKEN), false);
    assert.equal(logs.some((entry) => String(entry).includes(spawnCalls[0].options.env.PI_WEB_TOKEN)), false);

    await process.stop();
    assert.equal(process.status().state, "stopped");
    assert.equal(child.killed, true);
    assert.equal(spawnCalls.length, 1);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("quiesces through the local control socket and reports activity without a browser", async () => {
  const {root, config} = await fixture();
  const child = fakeChild();
  const commands = [];
  try {
    const managed = createPiWebUiProcess(config, {
      fetch: healthyFetch({
        ok: true,
        engine: "pi",
        build: {packageVersion: "0.79.0"},
        activity: {ok: true, quiesced: false, connectedClients: 0, activeConversations: 1, activeTools: 1, pendingMessages: 0},
      }),
      processKill: (_pid, signal) => child.kill(signal),
      spawn: () => child,
      controlConnect: () => {
        const socket = new EventEmitter();
        socket.destroy = () => {};
        socket.write = (line) => {
          const request = JSON.parse(String(line));
          commands.push(request.cmd);
          const body = request.cmd === "quiesce"
            ? {ok: true, quiesced: true, activeConversations: 0, activeTools: 0, pendingMessages: 0}
            : {ok: true, quiesced: false, connectedClients: 0, activeConversations: 1, activeTools: 1, pendingMessages: 0};
          setTimeout(() => socket.emit("data", Buffer.from(JSON.stringify(body) + "\n")), 5);
        };
        setImmediate(() => socket.emit("connect"));
        return socket;
      },
    });

    await managed.start();
    await assert.doesNotReject(() => managed.quiesce());
    const activity = await managed.activity();
    assert.deepEqual(commands, ["quiesce", "status"]);
    assert.deepEqual(activity, {
      ok: true,
      quiesced: false,
      connectedClients: 0,
      activeConversations: 1,
      activeTools: 1,
      pendingMessages: 0,
    });
    await managed.stop();
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("does not acknowledge a timed-out cooperative quiesce", async () => {
  const {root, config} = await fixture();
  const child = fakeChild();
  config.piWebUiQuiesceTimeoutMs = 10;
  try {
    const managed = createPiWebUiProcess(config, {
      fetch: healthyFetch(),
      processKill: (_pid, signal) => child.kill(signal),
      spawn: () => child,
      controlConnect: () => {
        const socket = new EventEmitter();
        socket.destroy = () => {};
        socket.write = () => {};
        return socket;
      },
    });
    await managed.start();
    await assert.rejects(() => managed.quiesce(), (error) => error.code === "pi_web_ui_quiesce_timeout");
    await managed.stop();
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("stops the managed process group so tool descendants cannot outlive the runner", async () => {
  const {root, config} = await fixture();
  const child = fakeChild(4343);
  const signals = [];
  try {
    const managed = createPiWebUiProcess(config, {
      fetch: healthyFetch(),
      processKill: (pid, signal) => {
        signals.push({pid, signal});
        child.kill(signal);
      },
      spawn: () => child,
    });
    await managed.start();
    await managed.stop();
    assert.deepEqual(signals, [{pid: -4343, signal: "SIGTERM"}]);
    assert.equal(child.killed, true);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("fails closed when the pinned MCP adapter is missing or incompatible", async () => {
  const {root, config} = await fixture();
  try {
    config.piMcpAdapterPath = path.join(root, "missing", "index.ts");
    await assert.rejects(() => createPiWebUiProcess(config).start(), (error) => error.code === "pi_mcp_adapter_missing");
    config.piMcpAdapterPath = path.join(root, "pi-mcp-adapter", "index.ts");
    await fs.writeFile(path.join(root, "pi-mcp-adapter", "package.json"), JSON.stringify({name: "pi-mcp-adapter", version: "9.9.9"}));
    await assert.rejects(() => createPiWebUiProcess(config).start(), (error) => error.code === "pi_mcp_adapter_incompatible");
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("retries transient health failures within a bounded startup", async () => {
  const {root, config} = await fixture();
  const child = fakeChild();
  let healthCalls = 0;
  try {
    const process = createPiWebUiProcess(config, {
      delay: async () => {},
      fetch: async () => {
        healthCalls += 1;
        if (healthCalls === 1) throw new Error("not listening");
        if (healthCalls === 2) return {ok: false, status: 503, json: async () => ({})};
        return {ok: true, status: 200, json: async () => ({ok: true, engine: "pi"})};
      },
      spawn: () => child,
    });

    await process.start();
    assert.equal(process.status().state, "ready");
    assert.equal(healthCalls, 3);
    await process.stop();
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("fails closed when the pinned runtime entry is missing", async () => {
  const {root, config} = await fixture();
  config.piWebUiRoot = path.join(root, "missing-runtime");
  let spawnCount = 0;
  try {
    const process = createPiWebUiProcess(config, {
      spawn: () => {
        spawnCount += 1;
        throw new Error("must not spawn");
      },
    });
    await assert.rejects(() => process.start(), (error) => error.code === "pi_web_ui_runtime_missing");
    assert.equal(process.status().state, "error");
    assert.equal(spawnCount, 0);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("reports an unexpected ready-child exit without respawning", async () => {
  const {root, config} = await fixture();
  const child = fakeChild();
  const exits = [];
  let spawnCount = 0;
  try {
    const process = createPiWebUiProcess(config, {
      fetch: healthyFetch(),
      onExit: (event) => exits.push(event),
      spawn: () => {
        spawnCount += 1;
        return child;
      },
    });

    await process.start();
    child.emit("exit", 17, "SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(process.status().state, "error");
    assert.equal(process.status().error, "pi_web_ui_process_exited");
    assert.equal(exits.length, 1);
    assert.equal(exits[0].error.code, "pi_web_ui_process_exited");
    await assert.rejects(() => process.start(), /pi_web_ui_process_exited/);
    assert.equal(spawnCount, 1);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});
