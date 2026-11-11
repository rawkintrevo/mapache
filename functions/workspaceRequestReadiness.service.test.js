"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {waitForWorkspaceRuntimeReady} = require("./workspaceRequestReadiness.service");

test("re-reads one session until its service URL is available", async () => {
  let clock = 0;
  let reads = 0;
  const result = await waitForWorkspaceRuntimeReady({
    workspaceId: "target",
    session: {id: "main", status: "provisioning", serviceUrl: ""},
    now: () => clock,
    delay: async (delayMs) => { clock += delayMs; },
    pollIntervalMs: 1000,
    timeoutMs: 5000,
    isReady: (session) => session?.status === "running" && Boolean(session.serviceUrl),
    readSession: async () => {
      reads += 1;
      return reads < 2 ? {id: "main", status: "provisioning", serviceUrl: ""} :
        {id: "main", status: "running", serviceUrl: "https://runner.example"};
    },
    logger: {},
  });

  assert.equal(result.session.serviceUrl, "https://runner.example");
  assert.equal(result.pollCount, 2);
  assert.equal(clock, 2000);
});

test("terminates on a terminal lifecycle state and on an injected deadline", async () => {
  await assert.rejects(() => waitForWorkspaceRuntimeReady({
    workspaceId: "target",
    session: {id: "main", status: "deleting", serviceUrl: ""},
    isReady: () => false,
    readSession: async () => { throw new Error("must not read a deleting session"); },
    logger: {},
  }), (error) => error.publicMessage === "workspace_request_runtime_start_failed");

  let clock = 0;
  await assert.rejects(() => waitForWorkspaceRuntimeReady({
    workspaceId: "target",
    session: {id: "main", status: "provisioning", serviceUrl: ""},
    now: () => clock,
    delay: async (delayMs) => { clock += delayMs; },
    pollIntervalMs: 1000,
    timeoutMs: 2500,
    isReady: () => false,
    readSession: async () => ({id: "main", status: "provisioning", serviceUrl: ""}),
    logger: {},
  }), (error) => error.status === 504 && error.publicMessage === "workspace_request_runtime_start_timeout");
  assert.equal(clock, 2500);
});
