"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const {boundedUnixSocketPath} = require("./unixSocketPath.helpers");
const {createConfig} = require("./config");
const {createAutomationAgentApiService} = require("./automationAgentApi.service");
const {createGoogleMcpTokenApiService} = require("./googleMcpTokenApi.service");

test("socket paths preserve short names and bound byte length without identity collisions", () => {
  assert.equal(boundedUnixSocketPath("/tmp/agent.sock"), "/tmp/agent.sock");
  const longRoot = `/var/lib/mapache/runtimes/auto-${"a".repeat(64)}`;
  const paths = [
    `${longRoot}/automation-agent.sock`,
    `${longRoot}/google-mcp-token.sock`,
    `${longRoot}b/automation-agent.sock`,
    `/tmp/${"é".repeat(60)}/agent.sock`,
  ];
  const bounded = paths.map(boundedUnixSocketPath);
  assert.equal(new Set(bounded).size, paths.length);
  bounded.forEach((value, index) => {
    assert.ok(Buffer.byteLength(value) <= 100);
    assert.equal(value, boundedUnixSocketPath(paths[index]));
    assert.ok(!value.startsWith(longRoot));
  });
});

test("scheduled automation config boots both real private broker sockets with a 64-character run ID", async () => {
  const runId = crypto.randomBytes(32).toString("hex");
  const runtimeId = `auto-${runId}`;
  const env = {
    MAPACHE_RUNTIME_KIND: "automation",
    WORKSPACE_STORAGE_MODE: "automation-readonly-gcs-v1",
    MAPACHE_RUNTIME_ID: runtimeId,
    MAPACHE_RUNTIME_ROOT: `/var/lib/mapache/runtimes/${runtimeId}`,
    MAPACHE_AUTOMATION_RUN_ID: runId,
    MAPACHE_AUTOMATION_AGENT_SOCKET: "",
    SESSION_ID: runtimeId,
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  let config;
  try {
    Object.assign(process.env, env);
    config = createConfig();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const automation = createAutomationAgentApiService(config);
  const google = createGoogleMcpTokenApiService({...config,
    googleMcpTokenRefreshUrl: "https://unused.invalid/token",
    googleMcpConnectionId: "test-connection",
    workspaceId: "test-workspace",
    shutdownToken: "test-only",
  });
  const sockets = [config.automationAgentSocketPath, config.googleMcpTokenSocketPath];
  assert.notEqual(sockets[0], sockets[1]);
  try {
    await automation.start();
    await google.start();
    for (const socketPath of sockets) {
      assert.ok(Buffer.byteLength(socketPath) <= 100);
      assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600);
      assert.equal((await fs.stat(path.dirname(socketPath))).mode & 0o777, 0o700);
      const status = await new Promise((resolve, reject) => {
        http.get({socketPath, path: "/not-an-api"}, (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        }).on("error", reject);
      });
      assert.ok([404, 405].includes(status));
    }
  } finally {
    await automation.stop();
    await google.stop();
    for (const socketPath of sockets) await fs.rm(path.dirname(socketPath), {recursive: true, force: true});
  }
});

for (const source of ["blank", "github"]) {
  test(`managed ${source} main materializes automation MCP with a private live socket`, async () => {
    const root = await fs.mkdtemp("/tmp/mapache-main-mcp-");
    const env = {
      MAPACHE_RUNTIME_KIND: "main", MAPACHE_AGENT_UI_VERSION: "pi-web-ui-v1",
      MAPACHE_AGENT_STATE_ROOT: root, MAPACHE_AUTOMATION_AGENT_SOCKET: "",
      MAPACHE_RUNTIME_STORAGE_MODE: "legacy", WORKSPACE_STORAGE_MODE: "legacy",
      WORKSPACE_SOURCE_TYPE: source,
    };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    let config;
    try {
      Object.assign(process.env, env);
      config = createConfig();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    const service = createAutomationAgentApiService(config);
    try {
      const {runnerMcpConfig} = require("./mcpConfig.service");
      const mcp = runnerMcpConfig(config).mcpServers["mapache-automations"];
      assert.equal(mcp.env.MAPACHE_AUTOMATION_AGENT_SOCKET, path.join(root, "automation-agent.sock"));
      await service.start();
      assert.equal(service.status().listening, true);
      assert.equal((await fs.stat(service.socketPath)).mode & 0o777, 0o600);
    } finally {
      await service.stop();
      await fs.rm(root, {recursive: true, force: true});
    }
  });
}
