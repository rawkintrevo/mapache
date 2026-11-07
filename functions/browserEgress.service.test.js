"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {browserEgressEnvironment} = require("./browserEgress.service");
const {normalizeEnvMap} = require("./env.helpers");
const {sessionRunnerEnv} = require("./cloudRun.service");
const resource = "projects/test-project/secrets/browser-egress/versions/1";
const route = {enabled: true, isolationReviewed: true, ownerUid: "owner", workspaceIds: ["accounting"],
  host: "office.example.com", port: 22, user: "tunnel", hostKey: "ssh-ed25519 AAAA",
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n"};
const session = {ownerUid: "owner", workspaceId: "accounting"};
const deps = (routes = [route]) => ({resource, readSecret: async () => ({version: 1, routes})});

test("disabled deployment never reads credentials", async () => {
  assert.deepEqual(await browserEgressEnvironment(session, {resource: "", readSecret: () => {throw Error();}}), []);
});
test("only exact owner AND workspace get one credential, including automation sessions", async () => {
  for (const s of [session, {...session, runtimeKind: "automation"}]) {
    const env = await browserEgressEnvironment(s, deps());
    assert.equal(env.length, 1);
    const value = JSON.parse(env[0].value);
    assert.equal(value.privateKey, route.privateKey);
    assert.equal(value.ownerUid, undefined);
  }
  for (const s of [{}, {...session, ownerUid: "other"}, {...session, workspaceId: "other"},
    {...session, ownerUid: "", browserEgress: route}, {browserEgress: route}]) {
    assert.deepEqual(await browserEgressEnvironment(s, deps()), []);
  }
});
test("operator disable revokes assignment on the next provision", async () => {
  assert.deepEqual(await browserEgressEnvironment(session, deps([{...route, enabled: false}])), []);
});
test("enabled routes require explicit isolation review; bad config fails closed", async () => {
  await assert.rejects(browserEgressEnvironment(session, deps([{...route, isolationReviewed: false}])), /isolation_review_required/);
  await assert.rejects(browserEgressEnvironment(session, deps([route, route])), /ambiguous_route/);
  for (const patch of [{host: "-oProxyCommand=bad"}, {user: "bad\nuser"}, {port: 0}, {port: "22"},
    {hostKey: "ssh-ed25519 AAAA\nother"}, {privateKey: "not a key"}]) {
    await assert.rejects(browserEgressEnvironment(session, deps([{...route, ...patch}])), /invalid_route/);
  }
});
test("secret resource is version pinned and errors cannot leak response/key data", async () => {
  await assert.rejects(browserEgressEnvironment(session, {...deps(), resource: resource.replace("/1", "/latest")}), /invalid_secret_resource/);
  await assert.rejects(browserEgressEnvironment(session, {...deps(), readSecret: () => {throw Error(route.privateKey);}}),
      (e) => e.message === "browser_egress_configuration_unavailable");
});
test("clients cannot inject proxy config through any generic environment map", () => {
  for (const name of ["MAPACHE_BROWSER_SSH_EGRESS", "BROWSER_EGRESS_CONFIG_SECRET"]) {
    assert.throws(() => normalizeEnvMap({[name]: "forged"}), /reserved_env_name/);
  }
});
test("provision/restart environment re-resolves trusted route, ignores session route hints", async () => {
  let calls = 0;
  const dependencies = {browserEgressEnvironment: async (s) => {calls++; return browserEgressEnvironment(s, deps());}};
  const s = {...session, imageKey: "pi-chrome", browserEgress: {host: "attacker"}};
  for (const options of [{}, {restartNonce: "restart"}]) {
    const env = await sessionRunnerEnv(s, options, dependencies);
    assert.equal(JSON.parse(env.find(e => e.name === "MAPACHE_BROWSER_SSH_EGRESS").value).host, route.host);
  }
  assert.equal(calls, 2);
  const foreign = await sessionRunnerEnv({...s, ownerUid: "other"}, {}, dependencies);
  assert.ok(!foreign.some(e => e.name === "MAPACHE_BROWSER_SSH_EGRESS"));
  await assert.rejects(sessionRunnerEnv({...s, workspaceEnv: {MAPACHE_BROWSER_SSH_EGRESS: "forged"}}, {}, dependencies), /reserved_env_name/);
});
