"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {createConfig} = require("./config");

test("workspace sync role defaults to writer for compatibility and accepts reader mode", () => {
  const previous = process.env.WORKSPACE_SYNC_ROLE;
  try {
    delete process.env.WORKSPACE_SYNC_ROLE;
    assert.equal(createConfig().workspaceSyncRole, "writer");
    process.env.WORKSPACE_SYNC_ROLE = "reader";
    assert.equal(createConfig().workspaceSyncRole, "reader");
    process.env.WORKSPACE_SYNC_ROLE = "unexpected";
    assert.equal(createConfig().workspaceSyncRole, "writer");
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_SYNC_ROLE;
    else process.env.WORKSPACE_SYNC_ROLE = previous;
  }
});

test("resource metrics sampling defaults to two seconds and accepts an override", () => {
  const previous = process.env.RESOURCE_METRICS_INTERVAL_MS;
  try {
    delete process.env.RESOURCE_METRICS_INTERVAL_MS;
    assert.equal(createConfig().resourceMetricsIntervalMs, 2000);
    process.env.RESOURCE_METRICS_INTERVAL_MS = "5000";
    assert.equal(createConfig().resourceMetricsIntervalMs, 5000);
  } finally {
    if (previous === undefined) delete process.env.RESOURCE_METRICS_INTERVAL_MS;
    else process.env.RESOURCE_METRICS_INTERVAL_MS = previous;
  }
});

test("Chrome runner configuration exposes stable browser contract URLs", () => {
  const names = [
    "RUNNER_CAPABILITIES",
    "MAPACHE_BROWSER_CDP_URL",
    "MAPACHE_BROWSER_STATUS_URL",
    "MAPACHE_BROWSER_ACTIVITY_URL",
    "MAPACHE_BROWSER_STATUS_COMMAND",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    RUNNER_CAPABILITIES: JSON.stringify({terminal: true, chrome: true}),
    MAPACHE_BROWSER_CDP_URL: "http://127.0.0.1:19222",
    MAPACHE_BROWSER_STATUS_URL: "http://127.0.0.1:18080/browser/status",
    MAPACHE_BROWSER_ACTIVITY_URL: "http://127.0.0.1:18080/browser/activity",
    MAPACHE_BROWSER_STATUS_COMMAND: "custom-chrome-status",
  });
  try {
    const config = createConfig();
    assert.equal(config.chromeEnabled, true);
    assert.equal(config.browserCdpUrl, "http://127.0.0.1:19222");
    assert.equal(config.browserStatusUrl, "http://127.0.0.1:18080/browser/status");
    assert.equal(config.browserActivityUrl, "http://127.0.0.1:18080/browser/activity");
    assert.equal(config.browserStatusCommand, "custom-chrome-status");
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("runner capability parsing preserves the supported capability contract", () => {
  const previous = process.env.RUNNER_CAPABILITIES;
  try {
    process.env.RUNNER_CAPABILITIES = JSON.stringify({terminal: true, preview: true});
    assert.equal(createConfig().runnerCapabilities.preview, true);
    process.env.RUNNER_CAPABILITIES = JSON.stringify({terminal: true});
    assert.equal(createConfig().runnerCapabilities.terminal, true);
  } finally {
    if (previous === undefined) delete process.env.RUNNER_CAPABILITIES;
    else process.env.RUNNER_CAPABILITIES = previous;
  }
});

test("marked runners use the managed pi-web-ui state contract while unmarked runners retain Pi paths", () => {
  const names = [
    "MAPACHE_AGENT_UI_VERSION",
    "MAPACHE_AGENT_STATE_ROOT",
    "MAPACHE_PI_WEB_UI_ROOT",
    "PI_CODING_AGENT_DIR",
    "PI_SESSION_DIR",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    MAPACHE_AGENT_STATE_ROOT: "/tmp/mapache-agent-state-test",
    MAPACHE_PI_WEB_UI_ROOT: "/opt/mapache/pi-web-ui-test",
    PI_CODING_AGENT_DIR: "/restored/pi-agent",
    PI_SESSION_DIR: "/restored/pi-session",
  });
  try {
    delete process.env.MAPACHE_AGENT_UI_VERSION;
    const legacy = createConfig();
    assert.equal(legacy.agentRuntimeEnabled, false);
    assert.equal(legacy.piAgentDir, "/restored/pi-agent");
    assert.equal(legacy.piSessionDir, "/restored/pi-session");

    process.env.MAPACHE_AGENT_UI_VERSION = "pi-web-ui-v1";
    const managed = createConfig();
    assert.equal(managed.agentRuntimeEnabled, true);
    assert.equal(managed.agentUiVersion, "pi-web-ui-v1");
    assert.equal(managed.piWebUiRoot, "/opt/mapache/pi-web-ui-test");
    assert.equal(managed.piWebUiHost, "127.0.0.1");
    assert.equal(managed.piWebUiPort, 8787);
    assert.equal(managed.piAgentDir, path.join("/tmp/mapache-agent-state-test", "pi"));
    assert.equal(managed.piSessionDir, path.join("/tmp/mapache-agent-state-test", "sessions"));
    assert.equal(managed.piWebUiDataDir, path.join("/tmp/mapache-agent-state-test", "ui"));
    assert.equal(managed.piMcpAdapterVersion, "2.32.1");
    assert.equal(managed.piMcpAdapterPath, path.join(process.env.HOME || "/root", ".pi", "agent", "npm", "node_modules", "pi-mcp-adapter", "index.ts"));
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("automation runtime config keeps identity scoped to its session", () => {
  const names = ["MAPACHE_RUNTIME_KIND", "MAPACHE_AUTOMATION_RUN_ID", "MAPACHE_AGENT_UI_VERSION", "MAPACHE_AGENT_RUNTIME_GENERATION", "SESSION_ID"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    MAPACHE_RUNTIME_KIND: "automation",
    MAPACHE_AUTOMATION_RUN_ID: "run-123",
    MAPACHE_AGENT_UI_VERSION: "pi-web-ui-v1",
    MAPACHE_AGENT_RUNTIME_GENERATION: "4",
    SESSION_ID: "auto-run-123",
  });
  try {
    const config = createConfig();
    assert.equal(config.runtimeKind, "automation");
    assert.equal(config.automationRunId, "run-123");
    assert.equal(config.sessionId, "auto-run-123");
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("private runtime mode namespaces all generated roots and ignores legacy shared paths", () => {
  const names = [
    "MAPACHE_RUNTIME_STORAGE_MODE",
    "MAPACHE_RUNTIME_ID",
    "MAPACHE_RUNTIME_ROOT",
    "MAPACHE_HOME_DIR",
    "MAPACHE_QA_DIR",
    "PI_CODING_AGENT_DIR",
    "PI_SESSION_DIR",
    "PI_WEB_MCP_ADAPTER_PATH",
    "CHROME_PROFILE_DIR",
    "RUNNER_CAPABILITIES",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const root = "/tmp/mapache-private-runtime-test/auto-run-1";
  Object.assign(process.env, {
    MAPACHE_RUNTIME_STORAGE_MODE: "private",
    MAPACHE_RUNTIME_ID: "run-1",
    MAPACHE_RUNTIME_ROOT: root,
    MAPACHE_HOME_DIR: "/workspace/shared-home",
    MAPACHE_QA_DIR: "/workspace/.mapache/qa",
    PI_CODING_AGENT_DIR: "/workspace/.pi/agent",
    PI_SESSION_DIR: "/workspace/.pi/sessions",
    PI_WEB_MCP_ADAPTER_PATH: "/root/.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts",
    CHROME_PROFILE_DIR: "/workspace/.chrome",
    RUNNER_CAPABILITIES: JSON.stringify({terminal: true, chrome: true}),
  });
  try {
    const config = createConfig();
    assert.equal(config.runtimeStorageMode, "private");
    assert.equal(config.runtimeIdentity, "run-1");
    assert.equal(config.privateRuntimeRoot, root);
    assert.equal(config.homeDir, path.join(root, "home"));
    assert.equal(config.piAgentDir, path.join(root, "agent-state", "pi"));
    assert.equal(config.piSessionDir, path.join(root, "agent-state", "sessions"));
    assert.equal(config.piMcpConfigPath, path.join(root, "agent-state", "pi", "mcp.json"));
    assert.equal(config.piWebUiControlPath, path.join(root, "agent-state", "ui", "pi-web-ui.sock"));
    assert.equal(config.chromeProfileDir, path.join(root, "chrome", "profile"));
    assert.equal(config.browserQaDir, path.join(root, "qa"));
    assert.equal(config.privateGitDir, path.join(root, "git", "repository"));
    assert.equal(config.homeSyncMode, "ephemeral");
    assert.equal(config.piSessionStoragePrefix, "");
    assert.equal(config.isPrivateRuntime, true);
    assert.equal(config.piMcpAdapterPath, "/root/.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts");
    for (const privatePath of [config.homeDir, config.piAgentDir, config.piSessionDir, config.chromeProfileDir]) {
      assert.equal(privatePath.startsWith("/workspace"), false);
    }
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
