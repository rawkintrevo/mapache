"use strict";

const assert = require("assert");
const {
  cleanPreviewPathSegment,
  createPreviewService,
  publicPreviewContentType,
  publicPreviewPath,
  signSessionAgentAccessToken,
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
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
