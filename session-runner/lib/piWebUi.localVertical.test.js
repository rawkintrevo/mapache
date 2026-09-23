"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {execFileSync} = require("node:child_process");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const test = require("node:test");
const WebSocket = require("ws");
const {WebSocketServer} = WebSocket;
const {createAgentCheckpointService} = require("./agentCheckpoint.service");
const {createAgentGateway} = require("./agentGateway");
const {createAgentSnapshotService} = require("./agentSnapshot.service");
const {createAgentWebSocketGateway} = require("./agentWebSocketGateway");
const {createBrowserAccessVerifier} = require("./browserAccess");
const {createWebSocketUpgradeRouter} = require("./webSocketUpgrade");
const {createWorkspaceAuthority} = require("./workspaceAuthority");
const {registerBrowserRoutes, registerPreviewRoutes} = require("../routes/browserPreviewRoutes");
const {createLocalVerticalModelServer} = require("./localVerticalModel");

const ENABLED = process.env.MAPACHE_RUN_PI_WEB_UI_VERTICAL === "1";
const IMAGE = process.env.MAPACHE_PI_CHROME_IMAGE || "mapache-task22-pi-chrome:latest";

test("composes concurrent admission with stale checkpoint publication fencing", async (t) => {
  const root = await fsp.mkdtemp(path.join("/tmp", "mapache-pi-web-authority-"));
  t.after(() => fsp.rm(root, {recursive: true, force: true}));
  const config = {
    agentRuntimeEnabled: true,
    agentUiVersion: "pi-web-ui-v1",
    agentRuntimeGeneration: "1",
    agentRuntimeBootInstanceId: "boot-a",
    internalStorageDir: ".mapache-internal",
    prefix: "local/vertical/workspace-1",
    sessionId: "vertical-session-1",
    workspaceId: "vertical-workspace-1",
    piAgentDir: path.join(root, "pi"),
    piSessionDir: path.join(root, "sessions"),
    piWebUiDataDir: path.join(root, "ui"),
    workspaceAuthorityRenewalIntervalMs: 60_000,
  };
  const store = createLocalAuthorityStore(config);
  const admin = {firestore: {FieldValue: {serverTimestamp: () => "LOCAL_TIMESTAMP"}}};
  const authorityA = createWorkspaceAuthority({
    admin,
    config,
    db: store.db,
    instanceId: "boot-a",
  });
  const authorityB = createWorkspaceAuthority({
    admin,
    config,
    db: store.db,
    instanceId: "boot-b",
  });

  const admissions = await Promise.allSettled([authorityA.acquire(), authorityB.acquire()]);
  assert.equal(admissions.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(store.workspace.agentRuntimeBootInstanceId, "boot-a");
  assert.equal(admissions[1].reason?.code, "workspace_runtime_authority_denied");

  const snapshotService = createAgentSnapshotService({config});
  const checkpointService = createAgentCheckpointService({admin, config, db: store.db});
  const staleCapture = {
    manifest: {
      manifestVersion: 1,
      kind: "mapache-agent-state-snapshot",
      storagePrefix: snapshotService.storagePrefix(),
      workspaceId: config.workspaceId,
      sessionId: config.sessionId,
      generation: 1,
      bootInstanceId: "boot-a",
      capturedAt: "2026-09-11T12:00:00.000Z",
      files: [],
      exclusions: [],
    },
    manifestRef: {bucketName: "local-fixture-bucket", objectPath: "stale/manifest.json"},
    captureId: "stale-capture",
  };

  await authorityA.release("handoff");
  await authorityB.acquire();
  assert.equal(store.workspace.agentRuntimeBootInstanceId, "boot-b");
  await assert.rejects(
      checkpointService.commitCheckpoint(staleCapture),
      (error) => error.code === "checkpoint_writer_not_current",
  );
  await authorityB.release("test");
});

test("runs the local pi-web vertical slice through the real image runtime and gateway", {
  skip: !ENABLED && "set MAPACHE_RUN_PI_WEB_UI_VERTICAL=1 after building the local pi-chrome image",
  timeout: 180_000,
}, async (t) => {
  // Bind mounts must be visible to the Docker daemon, so keep this bounded
  // fixture directory in the checked-out runner tree and remove it in finally.
  const root = await fsp.mkdtemp(path.join(process.cwd(), ".mapache-pi-web-vertical-"));
  const model = createLocalVerticalModelServer();
  let processSupervisor;
  let gatewayServer;
  let socket;
  let reconnect;
  const previousFixtureInstanceFile = process.env.MCP_FIXTURE_INSTANCE_FILE;
  try {
    const modelPort = await model.listen();
    const workspaceDir = path.join(root, "workspace");
    const agentDir = path.join(root, "agent");
    const sessionDir = path.join(root, "sessions");
    const uiDir = path.join(root, "ui");
    const stagingDir = path.join(root, "staging");
    await fsp.mkdir(workspaceDir, {recursive: true});
    await fsp.mkdir(agentDir, {recursive: true});
    await fsp.mkdir(sessionDir, {recursive: true});
    await fsp.writeFile(path.join(workspaceDir, "edited.txt"), "before\n");
    await fsp.copyFile(path.resolve(__dirname, "../test/fixtures/managed-mcp-single-server.mjs"),
      path.join(workspaceDir, "managed-mcp-single-server.mjs"));
    await fsp.writeFile(path.join(workspaceDir, ".mcp.json"), JSON.stringify({
      mcpServers: {
        fixture: {
          lifecycle: "eager",
          command: "/usr/bin/env",
          args: ["MCP_FIXTURE_INSTANCE_FILE=/workspace/mcp-instances.log", "/usr/local/bin/node", "/workspace/managed-mcp-single-server.mjs"],
        },
      },
    }));
    await fsp.writeFile(path.join(agentDir, "models.json"), JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${modelPort}/v1`,
          api: "openai-completions",
          apiKey: "local-fixture-key",
          models: [{
            id: "fixture-model",
            name: "Local vertical fixture",
            api: "openai-completions",
            reasoning: false,
            input: ["text"],
            contextWindow: 32768,
            maxTokens: 512,
          }],
        },
      },
    }, null, 2));
    process.env.MCP_FIXTURE_INSTANCE_FILE = "/workspace/mcp-instances.log";

    const upstreamPort = await unusedPort();
    const config = {
      agentRuntimeEnabled: true,
      agentUiVersion: "pi-web-ui-v1",
      agentRuntimeGeneration: "1",
      agentRuntimeBootInstanceId: "vertical-boot-1",
      agentStateRoot: root,
      bucketName: "local-fixture-bucket",
      internalStorageDir: ".mapache-internal",
      prefix: "local/vertical/workspace-1",
      sessionId: "vertical-session-1",
      workspaceId: "vertical-workspace-1",
      workspaceDir,
      piAgentDir: agentDir,
      piSessionDir: sessionDir,
      piWebUiRoot: "/opt/mapache/pi-web-ui",
      piWebUiDataDir: uiDir,
      piWebUiPiDir: agentDir,
      piWebUiSessionDir: sessionDir,
      piMcpAdapterPath: "/root/.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts",
      piWebUiHost: "127.0.0.1",
      piWebUiPort: upstreamPort,
      piWebUiHealthIntervalMs: 50,
      piWebUiStartupTimeoutMs: 20_000,
      piWebUiStopTimeoutMs: 5_000,
      piWebUiQuiesceTimeoutMs: 5_000,
      homeDir: root,
      previewEnabled: true,
      previewBasePath: "/preview",
      previewStaticRoot: workspaceDir,
      previewConfigPath: path.join(root, "preview.json"),
      previewInjectLogger: false,
      previewLogLimit: 20,
      runnerCapabilities: {chrome: true, preview: true, previewQa: false},
      chromeEnabled: true,
      chromeViewport: {width: 1440, height: 1000},
      browserQaDir: path.join(root, "qa"),
      browserQaExecutablePath: "/usr/bin/chromium",
      browserQaCommand: "mapache-preview-qa",
      browserQaStatePath: path.join(root, "qa", "last-run.json"),
    };

    const writer = {current: true};
    const secret = "local-vertical-access-secret";
    const generation = config.agentRuntimeGeneration;
    const accessVerifier = createBrowserAccessVerifier({
      audience: "agent",
      generation,
      requireAudience: true,
      requireGeneration: true,
      secret,
      sessionId: config.sessionId,
    });
    const accessToken = signedToken(secret, {
      aud: "agent",
      exp: Math.floor(Date.now() / 1000) + 600,
      gen: generation,
      sid: config.sessionId,
    });

    processSupervisor = createDockerPiWebUiProcess({config, image: IMAGE, modelPort, root});
    await processSupervisor.start();
    const fakeCheckpoint = createLocalCheckpointBoundary(config);
    const app = express();
    app.use("/agent", createAgentGateway({
      accessVerifier,
      getUpstreamHeaders: () => processSupervisor.upstreamHeaders(),
      assertCurrentWriter: () => {
        if (!writer.current) throw new Error("writer_authority_lost");
      },
      upstreamHost: config.piWebUiHost,
      upstreamPort: config.piWebUiPort,
      secureCookie: false,
    }).handle);
    app.use(express.json());
    const preview = require("./preview").createPreviewService(config);
    registerBrowserRoutes({
      app,
      admin: {firestore: {FieldValue: {serverTimestamp: () => "LOCAL_TIMESTAMP"}}},
      browserVncWebSocketPath: () => "browser/vnc",
      checkpointPublisher: fakeCheckpoint,
      chromeRuntime: {status: () => ({state: "ready", browser: "Chromium/local-fixture"})},
      config,
      activity: {updateSessionActivity: async () => {}},
      piWebUi: processSupervisor,
      expressStatic: express.static,
      preview,
      requireBrowserAccess: (request, response, next) => next(),
      requireBrowserOrRunnerAccess: (request, response, next) => next(),
      renderTerminalPage: () => "<html>local fixture</html>",
    });
    registerPreviewRoutes({
      app,
      browserQa: {status: () => ({state: "browser_ready"})},
      config,
      hasRunnerAccess: () => true,
      preview,
      requireBrowserAccess: (request, response, next) => next(),
      storage: null,
    });

    const agentWss = new WebSocketServer({noServer: true, maxPayload: 256 * 1024 * 1024});
    const router = createWebSocketUpgradeRouter({
      agentWebSocket: createAgentWebSocketGateway({
        accessVerifier,
        clientWss: agentWss,
        getUpstreamHeaders: () => processSupervisor.upstreamHeaders(),
        isCurrentWriter: () => writer.current,
        upstreamHost: config.piWebUiHost,
        upstreamPort: config.piWebUiPort,
      }).handleUpgrade,
      browserWss: new WebSocketServer({noServer: true}),
      terminalWss: new WebSocketServer({noServer: true}),
    });
    gatewayServer = http.createServer(app);
    gatewayServer.on("upgrade", router);
    await listen(gatewayServer);
    const publicPort = gatewayServer.address().port;
    const publicOrigin = `http://127.0.0.1:${publicPort}`;

    const health = await request(publicPort, `/runner/health?mapache_access=${encodeURIComponent(accessToken)}`);
    assert.equal(health.status, 200);
    assert.equal(health.body.agentRuntime.ready, true);
    assert.equal(health.body.agentRuntime.health.build.upstreamCommit, "46880b3772591beac91c0c1792bdc79a6fe3671f");
    assert.equal((await request(publicPort, `/capabilities?mapache_access=${encodeURIComponent(accessToken)}`)).body.browser.state, "ready");
    assert.equal((await request(publicPort, `/preview/status?mapache_access=${encodeURIComponent(accessToken)}`)).body.ok, true);
    const bootstrap = await request(publicPort, `/agent/?mapache_access=${encodeURIComponent(accessToken)}`);
    assert.equal(bootstrap.status, 303);
    assert.match(bootstrap.headers.location, /^\/agent\//);
    assert.match(String(bootstrap.headers["set-cookie"]?.[0]), /mapache_access=/);
    const forwardedHealth = await request(publicPort, `/agent/api/health?mapache_access=${encodeURIComponent(accessToken)}`);
    assert.equal(forwardedHealth.status, 200);
    assert.equal(forwardedHealth.body.ok, true);

    socket = await openAgentSocket(publicPort, accessToken, publicOrigin);
    socket.send(JSON.stringify({type: "hello", clientId: "vertical-client", locale: "en"}));
    await next(socket, (message) => message.type === "ready");
    let snapshot = await next(socket, (message) => message.type === "snapshot");
    const firstConversationId = snapshot.state.conversationId;
    socket.send(JSON.stringify({type: "set_model", modelId: "fixture/fixture-model"}));
    await next(socket, (message) => isSnapshot(message) && message.state.model?.id === "fixture-model");
    socket.send(JSON.stringify({type: "set_goal", goal: "Make the local vertical fixture pass", locked: false}));
    await next(socket, (message) => message.type === "goal_status" && message.status.goal === "Make the local vertical fixture pass");
    await next(socket, (message) => message.type === "goal_status" && message.status.verdict === "pass", 30_000);
    snapshot = socket.verticalSnapshotState;
    assert(snapshot.messages.length > 0);
    assert(socket.verticalMessageDeltaCount > 0, "the upstream must stream message deltas");
    assert.equal(await fsp.readFile(path.join(workspaceDir, "edited.txt"), "utf8"), "after\n");
    const mcpResults = model.requests.flatMap((payload) => payload.messages || [])
        .filter((message) => message.role === "tool" &&
          (message.name === "mcp" || message.tool_call_id === "vertical-mcp-call"));
    assert.equal(new Set(mcpResults.map((message) => message.tool_call_id || message.name)).size, 1);
    assert(mcpResults.some((message) => JSON.stringify(message).includes("vertical-tool-ok")),
      `fixture MCP result missing echo payload: ${JSON.stringify(mcpResults).slice(0, 1000)}`);
    assert(model.requests.length >= 4, "expected streamed main and isolated review model requests");

    socket.send(JSON.stringify({type: "list_sessions"}));
    const listed = await next(socket, (message) => message.type === "sessions");
    assert(listed.sessions.length >= 1);
    const firstSessionFile = snapshot.sessionFile;
    assert(listed.sessions.some((entry) => entry.path === firstSessionFile || entry.sessionFile === firstSessionFile));
    socket.send(JSON.stringify({type: "new_chat"}));
    const secondSnapshot = await next(socket, (message) => isSnapshot(message) && message.state.conversationId !== firstConversationId);
    assert.notEqual(secondSnapshot.state.conversationId, firstConversationId);
    socket.send(JSON.stringify({type: "list_sessions"}));
    const listedTwice = await next(socket, (message) => message.type === "sessions");
    assert(listedTwice.sessions.length >= 1);
    socket.send(JSON.stringify({
      type: "terminal_create",
      conversationId: secondSnapshot.state.conversationId,
      terminalId: "vertical-terminal",
      cwd: "/workspace",
      cols: 80,
      rows: 24,
    }));
    await next(socket, (message) => message.type === "terminal_list" || message.type === "terminal_output");
    socket.send(JSON.stringify({type: "run_command", terminalId: "vertical-terminal", command: {command: "printf shell-ok", cwd: "/workspace"}, cols: 80, rows: 24}));
    await next(socket, (message) => message.type === "terminal_output" && String(message.data || "").includes("shell-ok"));

    const providerCountBeforeRenewal = model.requests.length;
    await closeSocket(socket);
    socket = null;
    reconnect = await openAgentSocket(publicPort, signedToken(secret, {
      aud: "agent",
      exp: Math.floor(Date.now() / 1000) + 600,
      gen: generation,
      sid: config.sessionId,
    }), publicOrigin);
    reconnect.send(JSON.stringify({type: "hello", clientId: "vertical-client", locale: "en"}));
    await next(reconnect, (message) => message.type === "ready");
    await next(reconnect, isSnapshot);
    assert.equal(model.requests.length, providerCountBeforeRenewal, "reconnect must not start a model turn");

    reconnect.send(JSON.stringify({type: "switch_session", path: firstSessionFile}));
    const restored = await next(reconnect, (message) => isSnapshot(message) && message.state.sessionFile === firstSessionFile);
    assert(restored.state.messages.length > 0);

    const capture = await createAgentSnapshotService({config}).capture({
      stagingRoot: stagingDir,
      bootInstanceId: config.agentRuntimeBootInstanceId,
      generation: config.agentRuntimeGeneration,
    });
    assert(capture.manifest.files.some((entry) => entry.path.endsWith(".jsonl")));
    const uploaded = await fakeCheckpoint.uploadCapture(capture);
    await fakeCheckpoint.commitCheckpoint(uploaded);
    const checkpointCountBeforeRestart = model.requests.length;

    writer.current = false;
    const rejected = await request(publicPort, `/agent/api/health?mapache_access=${encodeURIComponent(accessToken)}`, {
      method: "POST",
      headers: {origin: publicOrigin},
    });
    assert.equal(rejected.status, 503);
    await assert.rejects(openAgentSocket(publicPort, accessToken, publicOrigin), /Unexpected server response: 503/);
    writer.current = true;

    await closeSocket(reconnect);
    reconnect = null;
    await processSupervisor.quiesce();
    await processSupervisor.stop();
    assert.equal(processSupervisor.status().state, "stopped");
    await processSupervisor.start();
    reconnect = await openAgentSocket(publicPort, accessToken, publicOrigin);
    reconnect.send(JSON.stringify({type: "hello", clientId: "vertical-client", locale: "en"}));
    await next(reconnect, (message) => message.type === "ready");
    await next(reconnect, isSnapshot);
    reconnect.send(JSON.stringify({type: "switch_session", path: firstSessionFile}));
    const restoredAfterRestart = await next(reconnect, (message) => isSnapshot(message) && message.state.sessionFile === firstSessionFile);
    assert(restoredAfterRestart.state.messages.length > 0);
    assert.equal(model.requests.length, checkpointCountBeforeRestart, "restart and history restore must not auto-resume execution");
  } finally {
    await closeSocket(socket);
    await closeSocket(reconnect);
    await processSupervisor?.stop().catch(() => {});
    if (gatewayServer) await closeServer(gatewayServer);
    await model.close().catch(() => {});
    if (previousFixtureInstanceFile === undefined) delete process.env.MCP_FIXTURE_INSTANCE_FILE;
    else process.env.MCP_FIXTURE_INSTANCE_FILE = previousFixtureInstanceFile;
    // The image runs as root and writes the mounted transcript/UI state. Remove
    // the bounded fixture through an explicit temporary-root mount so teardown
    // does not depend on the host test UID owning every nested path.
    try {
      execFileSync("docker", ["run", "--rm", "-v", `${root}:/state`, "--entrypoint", "sh", IMAGE,
        "-lc", "rm -rf /state/* /state/.[!.]* /state/..?*"], {stdio: "ignore"});
    } catch (error) {
      // The host-side removal below still handles a normal user-owned fixture.
    }
    await fsp.rm(root, {recursive: true, force: true});
  }
});

function createLocalCheckpointBoundary(config) {
  const admin = {firestore: {FieldValue: {serverTimestamp: () => "LOCAL_TIMESTAMP"}}};
  const workspace = {
    agentUiVersion: "pi-web-ui-v1",
    agentRuntimeSessionId: config.sessionId,
    agentRuntimeGeneration: config.agentRuntimeGeneration,
    agentRuntimeBootInstanceId: config.agentRuntimeBootInstanceId,
    agentRuntimeAuthorityState: "admitted",
  };
  const session = {
    agentUiVersion: "pi-web-ui-v1",
    agentRuntimeGeneration: config.agentRuntimeGeneration,
    agentRuntimeBootInstanceId: config.agentRuntimeBootInstanceId,
    agentRuntimeAuthorityState: "admitted",
  };
  const workspaceRef = {collection: () => ({doc: () => sessionRef})};
  const sessionRef = {};
  const db = {
    collection: () => ({doc: () => workspaceRef}),
    async runTransaction(callback) {
      return callback({
        async get(ref) {
          return {exists: true, data: () => ref === workspaceRef ? workspace : session};
        },
        update(ref, updates) {
          Object.assign(ref === workspaceRef ? workspace : session, updates);
        },
      });
    },
  };
  const objects = new Map();
  const storage = {
    bucket(bucketName) {
      return {
        file(objectPath) {
          const key = `${bucketName}/${objectPath}`;
          return {
            async save(content) { objects.set(key, Buffer.from(content)); },
            async download() { return [objects.get(key)]; },
          };
        },
        async upload(localPath, options) {
          const content = await fsp.readFile(localPath);
          objects.set(`${bucketName}/${options.destination}`, content);
        },
      };
    },
  };
  return createAgentCheckpointService({admin, config, db, storage});
}

function createDockerPiWebUiProcess({config, image, modelPort, root}) {
  const upstreamToken = "local-vertical-upstream-token";
  let containerId = "";
  let state = "stopped";
  let lastHealth = null;

  return {activity, health, quiesce, start, status, stop, upstreamHeaders};

  async function start() {
    if (state === "ready") return status();
    state = "starting";
    const args = [
      "run", "-d", "--network", "host",
      "-e", `PI_WEB_PORT=${config.piWebUiPort}`,
      "-e", "PI_WEB_HOST=127.0.0.1",
      "-e", "PI_WEB_CWD=/workspace",
      "-e", "PI_WEB_DATA_DIR=/ui",
      "-e", "PI_CODING_AGENT_DIR=/agent",
      "-e", "PI_CODING_AGENT_SESSION_DIR=/sessions",
      "-e", "PI_WEB_ENGINE=pi",
      "-e", "PI_WEB_MANAGED=1",
      "-e", "PI_WEB_TOKEN=" + upstreamToken,
      "-e", "PI_WEB_MCP_ADAPTER_PATH=/root/.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts",
      "-e", "MCP_FIXTURE_INSTANCE_FILE=/workspace/mcp-instances.log",
      "-v", `${config.workspaceDir}:/workspace`,
      "-v", `${config.piWebUiPiDir}:/agent`,
      "-v", `${config.piWebUiSessionDir}:/sessions`,
      "-v", `${config.piWebUiDataDir}:/ui`,
      "-v", `${root}:/state`,
      "--entrypoint", "node",
      image,
      "/opt/mapache/pi-web-ui/dist/server/index.js",
    ];
    containerId = execFileSync("docker", args, {encoding: "utf8"}).trim();
    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() <= deadline) {
        const result = await health();
        if (result.ready) {
          state = "ready";
          return result;
        }
        await delay(50);
      }
      let logs = "";
      try { logs = execFileSync("docker", ["logs", containerId], {encoding: "utf8"}); } catch (error) {}
      throw new Error(`local pi-web image health timeout${logs ? `: ${logs.slice(-2000)}` : ""}`);
    } catch (error) {
      await stop().catch(() => {});
      throw error;
    }
  }

  async function health() {
    if (!containerId) return {...status(), ready: false};
    try {
      const response = await fetch(`http://127.0.0.1:${config.piWebUiPort}/api/health`, {
        headers: {"x-pi-token": upstreamToken},
      });
      if (!response.ok) return {...status(), ready: false, error: `health_${response.status}`};
      const body = await response.json();
      lastHealth = body;
      return {...status(), ready: body.ok === true && body.engine === "pi", engine: body.engine, build: body.build, activity: body.activity};
    } catch (error) {
      return {...status(), ready: false, error: "health_unavailable"};
    }
  }

  async function quiesce() {
    const response = await controlRequest("quiesce");
    if (!response?.ok) throw new Error(response?.error || "local_pi_web_quiesce_failed");
    return response;
  }

  async function activity() {
    return await controlRequest("status") || {ok: false, error: "activity_unavailable"};
  }

  async function stop() {
    if (!containerId) {
      state = "stopped";
      return status();
    }
    state = "stopping";
    const current = containerId;
    try { execFileSync("docker", ["stop", "--time", "5", current], {stdio: "ignore"}); } catch (error) {}
    try { execFileSync("docker", ["rm", "-f", current], {stdio: "ignore"}); } catch (error) {}
    containerId = "";
    lastHealth = null;
    state = "stopped";
    return status();
  }

  function status() {
    return {
      enabled: true,
      state,
      ready: state === "ready" && Boolean(containerId),
      host: "127.0.0.1",
      port: config.piWebUiPort,
      pid: null,
      error: null,
      health: lastHealth ? {ready: true, engine: lastHealth.engine, build: lastHealth.build} : null,
    };
  }

  function upstreamHeaders() {
    return {"x-pi-token": upstreamToken};
  }

  function controlRequest(command) {
    if (!containerId) return null;
    const script = [
      "const net = require('node:net');",
      "const socket = net.createConnection('/ui/pi-web-ui.sock');",
      "let buffer = '';",
      "socket.on('connect', () => socket.write(JSON.stringify({cmd: process.argv[1]}) + '\\n'));",
      "socket.on('data', chunk => { buffer += chunk; const i = buffer.indexOf('\\n'); if (i >= 0) { process.stdout.write(buffer.slice(0, i)); socket.destroy(); } });",
      "socket.on('error', () => process.exit(2));",
    ].join(" ");
    try {
      const output = execFileSync("docker", ["exec", containerId, "node", "-e", script, command], {
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", ""],
      }).trim();
      return output ? JSON.parse(output) : null;
    } catch (error) {
      return null;
    }
  }
}

function createLocalAuthorityStore(config) {
  const workspaceRef = {id: config.workspaceId};
  const sessionsRef = {id: "sessions"};
  const sessionRef = {id: config.sessionId};
  workspaceRef.collection = (name) => {
    assert.equal(name, "sessions");
    return sessionsRef;
  };
  sessionsRef.doc = (id) => {
    assert.equal(id, config.sessionId);
    return sessionRef;
  };
  const workspace = {
    agentUiVersion: "pi-web-ui-v1",
    agentRuntimeGeneration: 1,
    agentRuntimeSessionId: config.sessionId,
    agentRuntimeState: "starting",
    agentRuntimeAuthorityState: "released",
  };
  const session = {
    agentUiVersion: "pi-web-ui-v1",
    agentRuntimeGeneration: 1,
    agentRuntimeState: "starting",
    agentRuntimeAuthorityState: "released",
    status: "provisioning",
  };
  let transactionTail = Promise.resolve();
  const db = {
    collection(name) {
      assert.equal(name, "workspaces");
      return {doc: (id) => {
        assert.equal(id, config.workspaceId);
        return workspaceRef;
      }};
    },
    runTransaction(callback) {
      const previous = transactionTail;
      let release;
      transactionTail = new Promise((resolve) => { release = resolve; });
      return (async () => {
        await previous;
        try {
          return await callback({
            async get(ref) {
              return {exists: true, data: () => ref === workspaceRef ? workspace : session};
            },
            update(ref, updates) {
              Object.assign(ref === workspaceRef ? workspace : session, updates);
            },
          });
        } finally {
          release();
        }
      })();
    },
  };
  return {db, session, workspace};
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signedToken(secret, claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function isSnapshot(message) {
  return message?.type === "snapshot" || message?.type === "snapshot_delta";
}

function messageContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n");
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function unusedPort() {
  const server = http.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function request(port, requestPath, {method = "GET", headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({host: "127.0.0.1", method, path: requestPath, port, headers}, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = text;
        try { parsed = JSON.parse(text); } catch (error) {}
        resolve({body: parsed, headers: response.headers, status: response.statusCode});
      });
    });
    request.once("error", reject);
    if (body !== undefined) request.end(body); else request.end();
  });
}

function openAgentSocket(port, token, origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/agent/ws?mapache_access=${encodeURIComponent(token)}`, {
      headers: {Origin: origin},
    });
    socket.verticalMessages = [];
    socket.verticalWaiters = [];
    socket.verticalSnapshotState = null;
    socket.verticalMessageDeltaCount = 0;
    socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch (error) { return; }
      if (isSnapshot(message)) {
        const previous = socket.verticalSnapshotState;
        const conversationChanged = message.type === "snapshot_delta" &&
          previous?.conversationId && message.state?.conversationId &&
          previous.conversationId !== message.state.conversationId;
        const messages = message.type === "snapshot" ? message.state.messages || [] :
          [...(conversationChanged ? [] : (previous?.messages || [])), ...(message.appended || [])];
        socket.verticalSnapshotState = {...(previous || {}), ...(message.state || {}), messages};
        message = {...message, state: socket.verticalSnapshotState};
      }
      if (message.type === "message_delta") socket.verticalMessageDeltaCount += 1;
      const waiter = socket.verticalWaiters.find((candidate) => candidate.predicate(message));
      if (waiter) {
        socket.verticalWaiters.splice(socket.verticalWaiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        socket.verticalMessages.push(message);
      }
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function next(socket, predicate, timeoutMs = 15_000) {
  const index = socket.verticalMessages.findIndex(predicate);
  if (index >= 0) return Promise.resolve(socket.verticalMessages.splice(index, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      reject,
      timer: setTimeout(() => {
        socket.verticalWaiters.splice(socket.verticalWaiters.indexOf(waiter), 1);
        const received = socket.verticalMessages.map((message) => message.type === "notice" ?
          `notice:${String(message.textEn || message.text || "").slice(0, 180)}` : message.type);
        reject(new Error(`timed out waiting for pi-web message; received ${received.join(",")}`));
      }, timeoutMs),
    };
    socket.verticalWaiters.push(waiter);
  });
}

function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once("close", resolve);
    socket.close();
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}
