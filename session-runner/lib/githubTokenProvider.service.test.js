"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createGithubTokenProvider} = require("./githubTokenProvider.service");

function response(status, body) {
  return {ok: status >= 200 && status < 300, status, headers: {get: () => String(Buffer.byteLength(body))}, text: async () => body};
}

test("reuses an unexpired token and refreshes within the safety window", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  let calls = 0;
  const provider = createGithubTokenProvider({now: () => now, config: {
    githubAutomationToken: "initial", githubAutomationTokenExpiresAt: "2026-01-01T01:00:00Z",
    githubAutomationTokenRefreshUrl: "https://functions.example/token", workspaceId: "w", sessionId: "s", shutdownToken: "x",
  }, fetchImpl: async () => { calls += 1; return response(200, JSON.stringify({accessToken: "fresh", expiresAt: "2026-01-01T02:00:00Z"})); }});
  assert.equal(await provider.getToken(), "initial");
  now += 56 * 60 * 1000;
  assert.equal(await provider.getToken(), "fresh");
  assert.equal(calls, 1);
});

test("collapses concurrent refreshes", async () => {
  let calls = 0;
  const provider = createGithubTokenProvider({config: {
    githubAutomationTokenRefreshUrl: "https://functions.example/token", workspaceId: "w", sessionId: "s", shutdownToken: "x",
  }, fetchImpl: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return response(200, JSON.stringify({accessToken: "fresh", expiresAt: "2030-01-01T00:00:00Z"})); }});
  assert.deepEqual(await Promise.all([provider.getToken(), provider.getToken()]), ["fresh", "fresh"]);
  assert.equal(calls, 1);
});
