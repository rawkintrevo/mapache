"use strict";

const assert = require("assert");
const {
  cleanPreviewPathSegment,
  createPreviewService,
  publicPreviewContentType,
  publicPreviewPath,
  signSessionAgentAccessToken,
  signSessionRemoteGatewayAccessToken,
  shouldServePublicPreviewIndexFallback,
} = require("./preview.service");

assert.strictEqual(cleanPreviewPathSegment(" user/workspace "), "user-workspace");
assert.strictEqual(cleanPreviewPathSegment("../../unsafe"), "unsafe");
assert.strictEqual(cleanPreviewPathSegment("\u0000"), "unknown");

assert.strictEqual(publicPreviewPath("/assets\\app.js"), "assets/app.js");
assert.strictEqual(publicPreviewPath("app/../index.html"), "index.html");
assert.strictEqual(publicPreviewPath("../../secrets.txt"), "");
assert.strictEqual(publicPreviewPath("/"), "index.html");

const htmlRequest = {get: (name) => name === "accept" ? "text/html,application/xhtml+xml" : ""};
const assetRequest = {get: (name) => name === "accept" ? "*/*" : ""};
assert.strictEqual(shouldServePublicPreviewIndexFallback(htmlRequest, "dashboard"), true);
assert.strictEqual(shouldServePublicPreviewIndexFallback(htmlRequest, "dashboard.js"), true);
assert.strictEqual(shouldServePublicPreviewIndexFallback(assetRequest, "dashboard.js"), false);

assert.strictEqual(publicPreviewContentType("index.html"), "text/html; charset=utf-8");
assert.strictEqual(publicPreviewContentType("assets/app.js"), "text/javascript; charset=utf-8");
assert.strictEqual(publicPreviewContentType("assets/data.bin"), "application/octet-stream");

console.log("preview service tests passed");

(async () => {
  const session = {
    agentRuntimeGeneration: "7",
    agentUiVersion: "pi-web-ui-v1",
    browserAccessTokenSecret: "browser-secret",
    capabilities: {chrome: true},
    harnessId: "pi",
    id: "session-1",
    imageKey: "pi-chrome",
    runnerSessionId: "session-1",
    serviceUrl: "https://runner.example/",
    status: "running",
  };
  const workspace = {agentUiVersion: "pi-web-ui-v1"};
  const service = createPreviewService({
    browserAccessTtlMs: 60 * 60 * 1000,
    requireSession: async () => ({sessionSnap: {data: () => session}, workspace}),
  });
  const result = await service.createSessionAccessUrls("owner-1", "workspace-1", "session-1");
  assert.match(result.agentUrl, /^https:\/\/runner\.example\/agent\/\?mapache_access=/);
  assert.match(result.terminalUrl, /^https:\/\/runner\.example\/\?mapache_access=/);
  const agentToken = new URL(result.agentUrl).searchParams.get("mapache_access");
  const agentPayload = JSON.parse(Buffer.from(agentToken.split(".")[0], "base64url").toString("utf8"));
  assert.deepStrictEqual(agentPayload, {
    aud: "agent",
    exp: agentPayload.exp,
    gen: "7",
    sid: "session-1",
  });
  assert.match(signSessionAgentAccessToken(session, Date.now() + 1000), /^.+\..+$/);

  const missingGeneration = await createPreviewService({
    browserAccessTtlMs: 60 * 60 * 1000,
    requireSession: async () => ({
      sessionSnap: {data: () => ({...session, agentRuntimeGeneration: ""})},
      workspace,
    }),
  }).createSessionAccessUrls("owner-1", "workspace-1", "session-1");
  assert.equal(missingGeneration.agentUrl, undefined);

  const unmarked = await createPreviewService({
    browserAccessTtlMs: 60 * 60 * 1000,
    requireSession: async () => ({
      sessionSnap: {data: () => session},
      workspace: {},
    }),
  }).createSessionAccessUrls("owner-1", "workspace-1", "session-1");
  assert.equal(unmarked.agentUrl, undefined);

  const shortLived = await createPreviewService({
    browserAccessTtlMs: 60 * 60 * 1000,
    requireSession: async () => ({
      sessionSnap: {data: () => ({
        ...session,
        qaFaultHarness: {
          id: "pi-web-failure-recovery-v1",
          accessRenewalTtlMs: 1000,
        },
      })},
      workspace,
    }),
  }).createSessionAccessUrls("owner-1", "workspace-1", "session-1");
  const shortLivedToken = new URL(shortLived.agentUrl).searchParams.get("mapache_access");
  const shortLivedPayload = JSON.parse(Buffer.from(shortLivedToken.split(".")[0], "base64url").toString("utf8"));
  assert.ok(shortLivedPayload.exp <= Math.floor(Date.now() / 1000) + 2);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

testRemoteGatewayAccess().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function testRemoteGatewayAccess() {
  const remoteDescriptor = {
    version: 1,
    backend: "remote-libvirt",
    workspaceId: "workspace-remote",
    ownerUid: "owner-1",
    hostId: "host-1",
    guestName: "mapache-ws-remote",
    dataDiskName: "mapache-ws-remote.qcow2",
    instanceName: "mapache-ws-remote",
    guestIp: "192.168.250.12",
    generation: 4,
    state: "running",
    guestResources: {vcpus: 2, memoryMiB: 8192, diskGiB: 40},
  };
  const session = {
    ownerUid: "owner-1",
    workspaceId: "workspace-remote",
    runnerSessionId: "session-remote",
    browserAccessTokenSecret: "browser-secret",
    runtimeProvider: remoteDescriptor,
    status: "running",
  };
  const service = createPreviewService({
    browserAccessTtlMs: 60 * 60 * 1000,
    remoteVmGatewayBaseUrl: () => "https://mapache-vm-gateway.example.com",
    requireSession: async () => ({sessionSnap: {data: () => session}, workspace: {runtimeProvider: remoteDescriptor}}),
  });
  const result = await service.createSessionAccessUrls("owner-1", "workspace-remote", "session-remote");
  assert.match(result.agentUrl, /^https:\/\/mapache-vm-gateway\.example\.com\/agent\/\?mapache_access=/);
  assert.equal(result.terminalUrl, null);
  const payload = JSON.parse(Buffer.from(new URL(result.agentUrl).searchParams.get("mapache_access").split(".")[0], "base64url").toString("utf8"));
  assert.deepStrictEqual(payload, {
    aud: "agent",
    exp: payload.exp,
    gen: "4",
    sid: "session-remote",
    uid: "owner-1",
    wid: "workspace-remote",
  });
  assert.match(signSessionRemoteGatewayAccessToken(session, "workspace-remote", "owner-1", Date.now() + 1000), /^.+\..+$/);
}
