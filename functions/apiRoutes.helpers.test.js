"use strict";

const assert = require("assert");
const {
  ROUTE_METHODS,
  routeAllowsMethod,
  routeRequest,
  routeRequiresAuth,
} = require("./apiRoutes.helpers");

function assertRoute(path, expected) {
  assert.deepStrictEqual(routeRequest(path), expected, path);
}

assertRoute("/api/me", {name: "me"});
assertRoute("/me", {name: "me"});
assertRoute("/api/automation-schedule-preview", {name: "automationSchedulePreview"});
assertRoute("/api/admin/users", {name: "adminUsers"});
assertRoute("/api/admin/users/uid-1/whitelist", {
  name: "adminUserWhitelist",
  uid: "uid-1",
});
assertRoute("/api/qa/custom-token", {name: "qaCustomToken"});
assertRoute("/api/public-previews/token_123/index.html", {
  name: "publicPreview",
  token: "token_123",
  path: "index.html",
});
assertRoute("/api/public-previews/token_123/assets/app.js", {
  name: "publicPreview",
  token: "token_123",
  path: "assets/app.js",
});
assertRoute("/api/pi-auth", {name: "piAuth"});
assertRoute("/api/pi-auth/providers/anthropic", {
  name: "piAuthProvider",
  provider: "anthropic",
});
assertRoute("/api/pi-auth/entries/entry-1", {
  name: "piAuthEntry",
  entryId: "entry-1",
});
assertRoute("/api/pi-auth/providers/openai-codex/device-code/start", {
  name: "openAiCodexDeviceCode",
  action: "start",
});
assertRoute("/api/workspaces", {name: "workspaces"});
assertRoute("/api/workspaces/workspace-1", {
  name: "workspace",
  workspaceId: "workspace-1",
});
assertRoute("/api/workspaces/workspace-1/mcp", {
  name: "workspaceMcp",
  workspaceId: "workspace-1",
});
assertRoute("/api/workspaces/workspace-1/automations", {
  name: "automations",
  workspaceId: "workspace-1",
});
assertRoute("/api/workspaces/workspace-1/automations/automation-1", {
  name: "automation",
  workspaceId: "workspace-1",
  automationId: "automation-1",
});
assertRoute("/api/workspaces/workspace-1/automations/automation-1/run", {
  name: "automationRun",
  workspaceId: "workspace-1",
  automationId: "automation-1",
});
assertRoute("/api/automation-runs", {name: "automationRuns"});
assertRoute("/api/automation-runs/run-1", {name: "automationRunDetail", runId: "run-1"});
assertRoute("/api/automation-runs/run-1/events", {name: "automationRunEvents", runId: "run-1"});
assertRoute("/api/agent/automations", {name: "automationAgent", resource: "definitions", action: "list"});
assertRoute("/api/agent/automations/automation-1", {
  name: "automationAgent", resource: "definition", action: "detail", automationId: "automation-1",
});
assertRoute("/api/agent/automations/automation-1/run", {
  name: "automationAgent", resource: "run", action: "enqueue", automationId: "automation-1",
});
assertRoute("/api/agent/automation-settings", {name: "automationAgent", resource: "settings", action: "detail"});
assertRoute("/api/agent/automation-runs", {name: "automationAgent", resource: "runs", action: "list"});
assertRoute("/api/agent/automation-runs/run-1/events", {
  name: "automationAgent", resource: "events", action: "list", runId: "run-1",
});
assertRoute("/api/workspaces/workspace-1/automation-storage/prepare", {
  name: "automationStoragePrepare",
  workspaceId: "workspace-1",
});
assertRoute("/api/automation-runs/run-1/restart", {name: "automationRunRestart", runId: "run-1"});
assertRoute("/api/automation-runs/run-1/cancel", {name: "automationRunCancel", runId: "run-1"});
assertRoute("/api/automation-runs/run-1/stop", {name: "automationRunStop", runId: "run-1"});
assertRoute("/api/workspaces/workspace-1/automation-settings", {
  name: "automationSettings",
  workspaceId: "workspace-1",
});
assertRoute("/api/workspaces/workspace-1/sessions", {
  name: "sessions",
  workspaceId: "workspace-1",
});
assertRoute("/api/workspaces/workspace-1/sessions/session-1", {
  name: "session",
  workspaceId: "workspace-1",
  sessionId: "session-1",
});
assertRoute("/api/workspaces/workspace-1/sessions/session-1/access-url", {
  name: "sessionAccess",
  workspaceId: "workspace-1",
  sessionId: "session-1",
});
assertRoute("/api/workspaces/workspace-1/sessions/session-1/logs", {
  name: "sessionLogs",
  workspaceId: "workspace-1",
  sessionId: "session-1",
});
assertRoute("/api/workspaces/workspace-1/sessions/session-1/long-running", {
  name: "sessionLongRunning",
  workspaceId: "workspace-1",
  sessionId: "session-1",
});
assertRoute("/api/workspaces/workspace-1/sessions/session-1/qa/faults", {
  name: "sessionQaFaults",
  workspaceId: "workspace-1",
  sessionId: "session-1",
});
assertRoute("/api/workspaces/workspace-1/sessions/session-1/share-preview", {
  name: "sessionSharePreview",
  workspaceId: "workspace-1",
  sessionId: "session-1",
});
for (const obsoletePath of [
  "/api/workspaces/workspace-1/files",
  "/api/workspaces/workspace-1/file",
  "/api/workspaces/workspace-1/create-file",
  "/api/workspaces/workspace-1/sessions/session-1/git-status",
  "/api/workspaces/workspace-1/sessions/session-1/models",
  "/api/workspaces/workspace-1/sessions/session-1/skills",
  "/api/workspaces/workspace-1/sessions/session-1/subagents",
]) {
  assertRoute(obsoletePath, {name: "unknown"});
}
assertRoute("/api/workspaces/workspace-1/sessions/session-1/subagent-chains", {name: "unknown"});
assertRoute("/api/workspaces/workspace-1/sessions/session-1/subagent-chains/delete", {name: "unknown"});
assertRoute("/api/github/connect", {name: "githubConnect"});
assertRoute("/api/github/connection", {name: "githubConnection"});
assertRoute("/api/github/disconnect", {name: "githubDisconnect"});
assertRoute("/api/github/callback", {name: "githubCallback"});
assertRoute("/api/github/repos", {name: "githubRepos"});
assertRoute("/api/google/callback", {name: "googleCallback"});
assertRoute("/api/google/services", {name: "googleCatalog"});
assertRoute("/api/google/connections", {name: "googleConnections"});
assertRoute("/api/google/connections/google-1", {name: "googleConnection", connectionId: "google-1"});
assertRoute("/api/workspaces/workspace-1/google", {name: "workspaceGoogle", workspaceId: "workspace-1"});
assertRoute("/api/workspaces/workspace-1/google/connect", {name: "googleConnectionStart", workspaceId: "workspace-1"});
assertRoute("/api/workspaces/workspace-1/google/binding", {name: "googleBinding", workspaceId: "workspace-1"});
assertRoute("/api/workspaces/workspace-1/sessions/session-1/nope", {name: "unknown"});

for (const [routeName, methods] of Object.entries(ROUTE_METHODS)) {
  for (const method of methods) {
    assert.strictEqual(routeAllowsMethod({name: routeName}, method), true, `${routeName} ${method}`);
  }
}

assert.strictEqual(routeAllowsMethod({name: "workspaces"}, "GET"), true);
assert.strictEqual(routeAllowsMethod({name: "workspaces"}, "PATCH"), false);
assert.strictEqual(routeAllowsMethod({name: "workspace"}, "PATCH"), true);
assert.strictEqual(routeAllowsMethod({name: "unknown"}, "GET"), false);
assert.strictEqual(routeAllowsMethod({name: "unknown"}, "OPTIONS"), true);
assert.strictEqual(routeAllowsMethod({name: "publicPreview"}, "GET"), true);
assert.strictEqual(routeAllowsMethod({name: "publicPreview"}, "POST"), false);

assert.strictEqual(routeRequiresAuth({name: "githubCallback"}, "GET"), false);
assert.strictEqual(routeRequiresAuth({name: "googleCallback"}, "GET"), false);
assert.strictEqual(routeRequiresAuth({name: "githubCallback"}, "POST"), true);
assert.strictEqual(routeRequiresAuth({name: "qaCustomToken"}, "POST"), false);
assert.strictEqual(routeRequiresAuth({name: "publicPreview"}, "GET"), false);
assert.strictEqual(routeRequiresAuth({name: "publicPreview"}, "POST"), true);
assert.strictEqual(routeRequiresAuth({name: "me"}, "GET"), true);
assert.strictEqual(routeRequiresAuth({name: "workspaces"}, "POST"), true);
assert.strictEqual(routeRequiresAuth({name: "unknown"}, "GET"), true);
assert.strictEqual(routeRequiresAuth({name: "unknown"}, "OPTIONS"), false);

console.log("api route helper tests passed");
