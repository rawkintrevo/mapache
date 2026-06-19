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
assertRoute("/api/workspaces/workspace-1/files", {
  name: "workspaceFiles",
  workspaceId: "workspace-1",
});
assertRoute("/api/workspaces/workspace-1/file", {
  name: "workspaceFile",
  workspaceId: "workspace-1",
});
assertRoute("/api/workspaces/workspace-1/file/download-url", {
  name: "workspaceFileDownloadUrl",
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
assertRoute("/api/workspaces/workspace-1/sessions/session-1/share-preview", {
  name: "sessionSharePreview",
  workspaceId: "workspace-1",
  sessionId: "session-1",
});
assertRoute("/api/workspaces/workspace-1/sessions/session-1/git-status", {
  name: "gitStatus",
  workspaceId: "workspace-1",
  sessionId: "session-1",
});
assertRoute("/api/workspaces/workspace-1/sessions/session-1/git-open-pr", {
  name: "gitOpenPr",
  workspaceId: "workspace-1",
  sessionId: "session-1",
});
assertRoute("/api/workspaces/workspace-1/sessions/session-1/pi-packages/install", {
  name: "piPackageInstall",
  workspaceId: "workspace-1",
  sessionId: "session-1",
});
assertRoute("/api/workspaces/workspace-1/sessions/session-1/skills", {
  name: "sessionSkills",
  workspaceId: "workspace-1",
  sessionId: "session-1",
});
assertRoute("/api/workspaces/workspace-1/sessions/session-1/skills/delete", {
  name: "sessionSkillDelete",
  workspaceId: "workspace-1",
  sessionId: "session-1",
});
assertRoute("/api/workspaces/workspace-1/sessions/session-1/pi-skills/delete", {
  name: "sessionSkillDelete",
  workspaceId: "workspace-1",
  sessionId: "session-1",
});
assertRoute("/api/github/connect", {name: "githubConnect"});
assertRoute("/api/github/connection", {name: "githubConnection"});
assertRoute("/api/github/disconnect", {name: "githubDisconnect"});
assertRoute("/api/github/callback", {name: "githubCallback"});
assertRoute("/api/github/repos", {name: "githubRepos"});
assertRoute("/api/workspaces/workspace-1/sessions/session-1/nope", {name: "unknown"});

for (const [routeName, methods] of Object.entries(ROUTE_METHODS)) {
  for (const method of methods) {
    assert.strictEqual(routeAllowsMethod({name: routeName}, method), true, `${routeName} ${method}`);
  }
}

assert.strictEqual(routeAllowsMethod({name: "workspaces"}, "GET"), true);
assert.strictEqual(routeAllowsMethod({name: "workspaces"}, "PATCH"), false);
assert.strictEqual(routeAllowsMethod({name: "unknown"}, "GET"), false);
assert.strictEqual(routeAllowsMethod({name: "unknown"}, "OPTIONS"), true);

assert.strictEqual(routeRequiresAuth({name: "githubCallback"}, "GET"), false);
assert.strictEqual(routeRequiresAuth({name: "githubCallback"}, "POST"), true);
assert.strictEqual(routeRequiresAuth({name: "qaCustomToken"}, "POST"), false);
assert.strictEqual(routeRequiresAuth({name: "publicPreview"}, "GET"), false);
assert.strictEqual(routeRequiresAuth({name: "publicPreview"}, "POST"), true);
assert.strictEqual(routeRequiresAuth({name: "me"}, "GET"), true);
assert.strictEqual(routeRequiresAuth({name: "workspaces"}, "POST"), true);
assert.strictEqual(routeRequiresAuth({name: "unknown"}, "GET"), true);
assert.strictEqual(routeRequiresAuth({name: "unknown"}, "OPTIONS"), false);

console.log("api route helper tests passed");
