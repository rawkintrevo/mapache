"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createVmRuntimeControlClient, createVmWorkspaceAuthority} = require("./vmRuntimeControl");
const {createAgentCheckpointService} = require("./agentCheckpoint.service");

const config = {workspaceId: "workspace", sessionId: "session", agentRuntimeGeneration: "3",
  vmControlUrl: "https://control.example", vmControlToken: "a".repeat(64)};

test("VM health does not query legacy checkpoint Firestore state", async () => {
  const service = createAgentCheckpointService({config: {...config, retainedDiskMode: true},
    db: new Proxy({}, {get: () => { throw new Error("Firestore forbidden"); }})});
  assert.deepEqual(await service.status(), {lastCheckpointAt: null, checkpointError: null});
});

test("VM control requests bind identity and refuse redirects", async () => {
  let sent;
  const client = createVmRuntimeControlClient({config, bootId: "boot", fetchImpl: async (url, options) => {
    sent = {url, ...options};
    return {ok: true, json: async () => ({ok: true})};
  }});
  await client.call("models.set", {models: ["model"]});
  assert.equal(sent.redirect, "error");
  assert.equal(sent.headers.authorization, `Bearer ${config.vmControlToken}`);
  assert.deepEqual(JSON.parse(sent.body), {action: "models.set", payload: {models: ["model"]}, bootId: "boot",
    workspaceId: "workspace", sessionId: "session", generation: 3});
  assert.throws(() => createVmRuntimeControlClient({config: {...config, vmControlUrl: "http://insecure.example"}}), /configuration/);
});

test("broker failure revokes local admission and stops the managed child once", async () => {
  let failing = false;
  let lost = 0;
  let cleared = 0;
  const authority = createVmWorkspaceAuthority({
    config, now: () => 1000,
    client: {bootId: "boot", call: async () => {
      if (failing) throw new Error("vm_generation_mismatch");
      return {leaseExpiresAt: 45000};
    }},
    onLost: async () => { lost++; },
    setIntervalFn: () => 1,
    clearIntervalFn: () => { cleared++; },
  });
  assert.equal(authority.isCurrentWriter(), false);
  await authority.acquire();
  assert.equal(authority.isCurrentWriter(), true);
  failing = true;
  await assert.rejects(authority.assertCurrentWriter(), /vm_generation_mismatch/);
  assert.equal(authority.isCurrentWriter(), false);
  assert.equal(lost, 1);
  assert.equal(await authority.renew(), false);
  assert.ok(cleared > 0);
});

test("local authority expires without renewal even if a timer is delayed", async () => {
  let time = 1000;
  const authority = createVmWorkspaceAuthority({config, now: () => time,
    client: {bootId: "boot", call: async () => ({leaseExpiresAt: 2000})},
    setIntervalFn: () => 1, clearIntervalFn: () => {},
  });
  await authority.acquire();
  time = 2001;
  assert.equal(authority.isCurrentWriter(), false);
});
