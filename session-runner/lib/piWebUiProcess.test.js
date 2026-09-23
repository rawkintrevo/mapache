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
  config.automationAgentSocketPath = "/var/lib/mapache/runtimes/run-1/automation-agent.sock";
  try {
    const process = createPiWebUiProcess(config, {
      env: {PATH: "/usr/bin", GOOGLE_APPLICATION_CREDENTIALS: "/secret", SESSION_SHUTDOWN_TOKEN: "runner-secret"},
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
    assert.equal(spawnCalls[0].options.env.SESSION_SHUTDOWN_TOKEN, undefined);
    assert.equal(spawnCalls[0].options.env.MAPACHE_AUTOMATION_AGENT_SOCKET, config.automationAgentSocketPath);
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

test("private managed child loads MCP config from its local Pi state root", async () => {
  const {root, config} = await fixture();
  const child = fakeChild(4343);
  const privateMcpPath = path.join(root, "private", "pi", "mcp.json");
  config.isPrivateRuntime = true;
  config.piMcpConfigPath = privateMcpPath;
  try {
    const managed = createPiWebUiProcess(config, {
      env: {PATH: "/usr/bin"},
      fetch: healthyFetch(),
      spawn: (_command, args, options) => {
        assert.deepEqual(args.slice(1), ["--mcp-config", privateMcpPath]);
        assert.equal(options.env.PI_WEB_MCP_CONFIG, privateMcpPath);
        return child;
      },
    });
    await managed.start();
    await managed.stop();
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("keeps Google renewal inputs in the runner and passes only its socket path", async () => {
  const {root, config} = await fixture();
  const child = fakeChild(4444);
  config.googleMcpTokenSocketPath = "/var/lib/mapache/google-token.sock";
  const env = {
    PATH: "/usr/bin",
    GOOGLE_MCP_TOKEN_REFRESH_URL: "https://functions.example/googleMcpToken",
    GOOGLE_MCP_CONNECTION_ID: "connection-a",
    GOOGLE_MCP_TOKEN_SOCKET_PATH: "/unsafe/direct-path.sock",
    SESSION_SHUTDOWN_TOKEN: "runner-secret",
  };
  let childEnvironment;
  try {
    const managed = createPiWebUiProcess(config, {
      env,
      fetch: healthyFetch(),
      spawn: (_command, _args, options) => {
        childEnvironment = options.env;
        return child;
      },
    });
    await managed.start();
    assert.equal(childEnvironment.SESSION_SHUTDOWN_TOKEN, undefined);
    assert.equal(childEnvironment.GOOGLE_MCP_TOKEN_REFRESH_URL, undefined);
    assert.equal(childEnvironment.GOOGLE_MCP_CONNECTION_ID, undefined);
    assert.equal(childEnvironment.GOOGLE_MCP_TOKEN_SOCKET_PATH, undefined);
    assert.equal(childEnvironment.GOOGLE_MCP_TOKEN_SOCKET, config.googleMcpTokenSocketPath);
    await managed.stop();
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("quiesces through the local control socket and reports activity without a browser", async () => {
  const {root, config} = await fixture();
  const child = fakeChild();
  const commands = [];
  const requests = [];
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
          requests.push(request);
          commands.push(request.cmd);
          const body = request.cmd === "quiesce"
            ? {ok: true, quiesced: true, activeConversations: 0, activeTools: 0, pendingMessages: 0}
            : request.cmd === "startAutomation"
              ? {ok: true, runId: request.runId, conversationId: "c1", status: "running"}
              : request.cmd === "automationStatus"
                ? {ok: true, runId: request.runId, conversationId: "c1", status: "running"}
                : request.cmd === "cancelAutomation"
                  ? {ok: true, runId: request.runId, conversationId: "c1", status: "canceled"}
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
    const started = await managed.startAutomation({runId: "run-1", prompt: "run it", modelRef: "openai/gpt-5"});
    const automation = await managed.automationStatus("run-1");
    const canceled = await managed.cancelAutomation("run-1");
    assert.deepEqual(commands, ["quiesce", "status", "startAutomation", "automationStatus", "cancelAutomation"]);
    assert.deepEqual(requests.slice(2), [
      {cmd: "startAutomation", runId: "run-1", prompt: "run it", modelRef: "openai/gpt-5"},
      {cmd: "automationStatus", runId: "run-1"},
      {cmd: "cancelAutomation", runId: "run-1"},
    ]);
    assert.deepEqual(started, {ok: true, runId: "run-1", conversationId: "c1", status: "running"});
    assert.deepEqual(automation, {ok: true, runId: "run-1", conversationId: "c1", status: "running"});
    assert.deepEqual(canceled, {ok: true, runId: "run-1", conversationId: "c1", status: "canceled"});
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

test("allows automation initialization to outlive the shutdown control deadline", async () => {
  const {root, config} = await fixture();
  const child = fakeChild();
  config.piWebUiQuiesceTimeoutMs = 10;
  config.piWebUiAutomationStartTimeoutMs = 50;
  try {
    const managed = createPiWebUiProcess(config, {
      fetch: healthyFetch(),
      processKill: (_pid, signal) => child.kill(signal),
      spawn: () => child,
      controlConnect: () => {
        const socket = new EventEmitter();
        socket.destroy = () => {};
        socket.write = (line) => {
          const request = JSON.parse(String(line));
          if (request.cmd === "startAutomation") {
            setTimeout(() => socket.emit("data", Buffer.from(JSON.stringify({
              ok: true,
              runId: request.runId,
              conversationId: "conversation-1",
              status: "running",
            }) + "\n")), 20);
          }
        };
        setImmediate(() => socket.emit("connect"));
        return socket;
      },
    });
    await managed.start();
    const response = await managed.startAutomation({runId: "run-1", prompt: "write a poem"});
    assert.equal(response.ok, true);
    assert.equal(response.status, "running");
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

test("allows a slow cold start within the managed UI startup budget", async () => {
  const {root, config} = await fixture();
  const child = fakeChild();
  let clock = 0;
  let healthCalls = 0;
  config.piWebUiHealthIntervalMs = 1_000;
  config.piWebUiStartupTimeoutMs = 90_000;
  try {
    const process = createPiWebUiProcess(config, {
      now: () => clock,
      delay: async (delayMs) => { clock += delayMs; },
      fetch: async () => {
        healthCalls += 1;
        if (clock < 31_000) return {ok: false, status: 503, json: async () => ({})};
        return {ok: true, status: 200, json: async () => ({ok: true, engine: "pi"})};
      },
      spawn: () => child,
    });

    await process.start();
    assert.equal(process.status().state, "ready");
    assert.equal(clock >= 31_000, true);
    assert.equal(healthCalls, 32);
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

test("automation child and Pi tools use the persistent output directory as cwd", async (t) => {
  const {root, config} = await fixture();
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  config.automationOutputDir = "/automation-output/11111111-1111-4111-8111-111111111111";
  let options;
  const managed = createPiWebUiProcess(config, {
    env: {PATH: "/usr/bin"},
    fetch: healthyFetch(),
    spawn: (_command, _args, spawnOptions) => {
      options = spawnOptions;
      return fakeChild();
    },
  });
  await managed.start();
  assert.equal(options.cwd, config.automationOutputDir);
  assert.equal(options.env.PI_WEB_CWD, config.automationOutputDir);
  assert.notEqual(options.cwd, config.workspaceDir);
  await managed.stop();
});
