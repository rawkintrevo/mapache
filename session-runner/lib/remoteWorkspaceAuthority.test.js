"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {createRemoteWorkspaceAuthority} = require("./remoteWorkspaceAuthority");

function fixture() {
  let time = 100000;
  let failure;
  let calls = 0;
  let lost = 0;
  const config = {agentRuntimeGeneration: 2, agentRuntimeBootInstanceId: "boot-1", workspaceId: "w1", sessionId: "s1"};
  const service = createRemoteWorkspaceAuthority({config, now: () => time,
    setIntervalFn: () => 1, clearIntervalFn: () => {}, setTimeoutFn: () => 2, clearTimeoutFn: () => {},
    onLost: () => { lost += 1; },
    remoteCredentials: {enabled: () => true, materialize: async (options) => {
      assert.equal(options.force, true); calls += 1;
      if (failure) throw new Error(failure);
      return {generation: 2, expiresAt: new Date(time + 300000).toISOString()};
    }},
  });
  return {service, config, advance: (n) => { time += n; }, fail: () => { failure = "revoked"; },
    counts: () => ({calls, lost})};
}

test("remote authority requires broker admission and fences failure/expiry without cloud credentials", async () => {
  const f = fixture();
  assert.equal(f.service.isCurrentWriter(), false);
  assert.equal((await f.service.acquire()).bootInstanceId, "boot-1");
  assert.equal(await f.service.assertCurrentWriter(), true);
  f.advance(5000);
  await f.service.renew();
  assert.equal(f.counts().calls, 2);
  f.fail();
  await assert.rejects(f.service.renew(), /workspace_runtime_authority_denied/);
  assert.equal(f.service.isCurrentWriter(), false);
  assert.equal(f.counts().lost, 1);
  await assert.rejects(f.service.assertCurrentWriter());
  assert.equal(f.counts().lost, 1);
  const g = fixture();
  await g.service.acquire();
  g.advance(15001);
  assert.equal(g.service.isCurrentWriter(), false);
  await assert.rejects(g.service.assertCurrentWriter());
  assert.equal(g.counts().lost, 1);
});

test("missing boot identity and wrong generation cannot acquire remote authority", async () => {
  const f = fixture();
  f.config.agentRuntimeBootInstanceId = "";
  await assert.rejects(f.service.acquire());
  assert.equal(f.counts().calls, 0);
  const g = fixture();
  g.config.agentRuntimeGeneration = 3;
  await assert.rejects(g.service.acquire());
  assert.equal(g.service.isCurrentWriter(), false);
});

test("release fences an outstanding broker response", async () => {
  let resolve;
  const service = createRemoteWorkspaceAuthority({config: {agentRuntimeBootInstanceId: "boot-1", agentRuntimeGeneration: 1},
    remoteCredentials: {enabled: () => true, materialize: () => new Promise((r) => { resolve = r; })}});
  const pending = service.acquire();
  await service.release();
  resolve({generation: 1, expiresAt: new Date(Date.now() + 60000).toISOString()});
  await assert.rejects(pending);
  assert.equal(service.isCurrentWriter(), false);
});
