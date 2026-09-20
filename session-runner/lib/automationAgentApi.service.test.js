"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createAutomationAgentApiService} = require("./automationAgentApi.service");
const {signClaims} = require("../../functions/automationAgentAuth.service");

function response(status, body) {
  return {ok: status >= 200 && status < 300, status, json: async () => body};
}

function token(exp) {
  return signClaims({
    iss: "mapache", aud: "automation-api", iat: exp - 300, exp,
    ownerUid: "user-1", workspaceId: "workspace-1", sessionId: "session-1",
    generation: "7", bootInstanceId: "boot-1",
  }, "test-signing-secret");
}

test("runner adapter refreshes in memory and never sends shutdown credentials to the API", async () => {
  let now = Date.parse("2026-09-20T12:00:00Z");
  const requests = [];
  const service = createAutomationAgentApiService({
    automationAgentApiUrl: "https://functions.example",
    automationAgentTokenUrl: "https://functions.example/token",
    shutdownToken: "runner-secret",
    workspaceId: "workspace-1",
    sessionId: "session-1",
  }, {
    now: () => now,
    fetch: async (url, options) => {
      requests.push({url, options});
      if (url.endsWith("/token")) return response(200, {accessToken: token(Math.floor(now / 1000) + 300)});
      return response(200, {automations: []});
    },
  });

  assert.deepEqual(await service.call("/api/agent/automations"), {automations: []});
  assert.deepEqual(await service.call("/api/agent/automations"), {automations: []});
  assert.equal(requests.filter((request) => request.url.endsWith("/token")).length, 1);
  assert.equal(requests[0].options.headers["x-shutdown-token"], "runner-secret");
  assert.equal(requests[1].options.headers["x-shutdown-token"], undefined);
  assert.match(requests[1].options.headers.Authorization, /^Bearer /);

  now += 280 * 1000;
  await service.call("/api/agent/automations");
  assert.equal(requests.filter((request) => request.url.endsWith("/token")).length, 2);
});

test("runner adapter rejects arbitrary local paths before making a remote request", async () => {
  let calls = 0;
  const service = createAutomationAgentApiService({
    automationAgentApiUrl: "https://functions.example",
    automationAgentTokenUrl: "https://functions.example/token",
    shutdownToken: "runner-secret",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    automationAgentSocketPath: "/tmp/mapache-test-automation-agent.sock",
  }, {fetch: async () => { calls += 1; return response(500, {}); }});
  assert.equal(service.socketPath, "/tmp/mapache-test-automation-agent.sock");
  assert.equal(calls, 0);
});
