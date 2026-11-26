"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

for (const remoteGuestMode of [false, true]) test(`server bootstrap wires authority before consumers (remote=${remoteGuestMode})`, async () => {
  const noop = () => {};
  const service = new Proxy({}, {get: () => noop});
  const activity = {};
  const isCurrentWriter = () => true;
  let started = false;
  let gitCreated = false;
  let onLost;
  let stopped = 0;
  const exits = [];
  const express = Object.assign(() => service, {json: noop, static: noop});
  const overrides = {
    path,
    http: {createServer: () => service},
    express,
    ws: {WebSocketServer: function() { return service; }},
    "./lib/config": {createConfig: () => ({remoteGuestMode})},
    "./lib/workspaceAuthority": {
      createWorkspaceAuthority: (options) => {
        assert.equal(remoteGuestMode, false);
        onLost = options.onLost;
        return {...service, isCurrentWriter};
      },
    },
    "./lib/remoteWorkspaceAuthority": {
      createRemoteWorkspaceAuthority: (options) => {
        assert.equal(remoteGuestMode, true);
        assert.ok(options.remoteCredentials);
        onLost = options.onLost;
        return {...service, isCurrentWriter};
      },
    },
    "./lib/remoteAuthorityLoss": {
      createRemoteAuthorityLossHandler: (options) => require("./remoteAuthorityLoss")
          .createRemoteAuthorityLossHandler({...options, exit: (code) => exits.push(code)}),
    },
    "./lib/piWebUiProcess": {
      createPiWebUiProcess: () => ({...service, stop: async () => { stopped++; }}),
    },
    "./lib/activity": {
      createActivityService: (options) => {
        assert.equal(options.isCurrentRuntime, isCurrentWriter);
        return activity;
      },
    },
    "./lib/git": {
      createGitService: (options) => {
        assert.equal(options.activity, activity);
        gitCreated = true;
        return service;
      },
    },
    "./lib/runnerLifecycle": {
      createRunnerLifecycleCoordinator: (options) => {
        assert.equal(options.activity, activity);
        return {start: () => { started = true; return Promise.resolve(); }};
      },
    },
  };
  // Execute the real entrypoint, replacing external services so no network,
  // child processes, listeners, or signal handlers escape this test.
  const filename = path.join(__dirname, "..", "server.js");
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    __dirname: path.dirname(filename),
    console,
    process: {once: noop, exit: (code) => assert.fail(`unexpected exit ${code}`)},
    require: (name) => overrides[name] || new Proxy({}, {get: () => () => service}),
  }, {filename});
  assert.equal(gitCreated, true);
  assert.equal(started, true);
  await onLost();
  assert.equal(stopped, 1);
  assert.deepEqual(exits, remoteGuestMode ? [1] : []);
});
