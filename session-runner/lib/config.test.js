"use strict";

const assert = require("node:assert/strict");
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
