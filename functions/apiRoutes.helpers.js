"use strict";

const OPENAI_CODEX_PROVIDER = "openai-codex";

function routeRequest(path) {
  const parts = String(path || "").replace(/^\/api\/?/, "/").split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "me") return {name: "me"};
  if (parts.length === 2 && parts[0] === "qa" && parts[1] === "custom-token") {
    return {name: "qaCustomToken"};
  }
  if (parts.length === 1 && parts[0] === "pi-auth") return {name: "piAuth"};
  if (parts.length === 3 && parts[0] === "pi-auth" && parts[1] === "providers") {
    return {name: "piAuthProvider", provider: parts[2]};
  }
  if (parts.length === 3 && parts[0] === "pi-auth" && parts[1] === "entries") {
    return {name: "piAuthEntry", entryId: parts[2]};
  }
  if (
    parts.length === 5 &&
    parts[0] === "pi-auth" &&
    parts[1] === "providers" &&
    parts[2] === OPENAI_CODEX_PROVIDER &&
    parts[3] === "device-code"
  ) {
    return {name: "openAiCodexDeviceCode", action: parts[4]};
  }
  if (parts.length === 1 && parts[0] === "workspaces") return {name: "workspaces"};
  if (parts.length === 2 && parts[0] === "workspaces") {
    return {name: "workspace", workspaceId: parts[1]};
  }
  if (parts.length === 3 && parts[0] === "workspaces" && parts[2] === "files") {
    return {name: "workspaceFiles", workspaceId: parts[1]};
  }
  if (parts.length === 3 && parts[0] === "workspaces" && parts[2] === "file") {
    return {name: "workspaceFile", workspaceId: parts[1]};
  }
  if (parts.length === 4 && parts[0] === "workspaces" && parts[2] === "file" && parts[3] === "download-url") {
    return {name: "workspaceFileDownloadUrl", workspaceId: parts[1]};
  }
  if (parts.length === 3 && parts[0] === "workspaces" && parts[2] === "sessions") {
    return {name: "sessions", workspaceId: parts[1]};
  }
  if (parts.length === 4 && parts[0] === "workspaces" && parts[2] === "sessions") {
    return {name: "session", workspaceId: parts[1], sessionId: parts[3]};
  }

  const sessionActionRoutes = new Map([
    ["resize", "resizeSession"],
    ["restart", "restartSession"],
    ["stop", "stopSession"],
    ["access-url", "sessionAccess"],
    ["pi-auth-selection", "sessionPiAuthSelection"],
    ["git-status", "gitStatus"],
    ["git-pull", "gitPull"],
    ["git-stage", "gitStage"],
    ["git-unstage", "gitUnstage"],
    ["git-commit", "gitCommit"],
    ["git-push", "gitPush"],
    ["git-open-pr", "gitOpenPr"],
    ["pi-packages", "piPackages"],
    ["pi-skills", "piSkills"],
  ]);
  if (parts.length === 5 && parts[0] === "workspaces" && parts[2] === "sessions") {
    const name = sessionActionRoutes.get(parts[4]);
    if (name) return {name, workspaceId: parts[1], sessionId: parts[3]};
  }

  const piPackageActionRoutes = new Map([
    ["install", "piPackageInstall"],
    ["remove", "piPackageRemove"],
    ["update", "piPackageUpdate"],
  ]);
  if (
    parts.length === 6 &&
    parts[0] === "workspaces" &&
    parts[2] === "sessions" &&
    parts[4] === "pi-packages"
  ) {
    const name = piPackageActionRoutes.get(parts[5]);
    if (name) return {name, workspaceId: parts[1], sessionId: parts[3]};
  }
  if (
    parts.length === 6 &&
    parts[0] === "workspaces" &&
    parts[2] === "sessions" &&
    parts[4] === "pi-skills" &&
    parts[5] === "delete"
  ) {
    return {name: "piSkillDelete", workspaceId: parts[1], sessionId: parts[3]};
  }
  if (parts.length === 2 && parts[0] === "github" && parts[1] === "connect") {
    return {name: "githubConnect"};
  }
  if (parts.length === 2 && parts[0] === "github" && parts[1] === "callback") {
    return {name: "githubCallback"};
  }
  if (parts.length === 2 && parts[0] === "github" && parts[1] === "repos") {
    return {name: "githubRepos"};
  }
  return {name: "unknown"};
}

const ROUTE_METHODS = Object.freeze({
  githubCallback: ["GET"],
  me: ["GET"],
  qaCustomToken: ["POST"],
  piAuth: ["GET"],
  piAuthProvider: ["PUT", "DELETE"],
  piAuthEntry: ["DELETE"],
  openAiCodexDeviceCode: ["POST"],
  workspaces: ["GET", "POST"],
  workspace: ["DELETE"],
  workspaceFiles: ["GET"],
  workspaceFile: ["GET", "PUT", "POST"],
  workspaceFileDownloadUrl: ["POST"],
  sessions: ["GET", "POST"],
  session: ["DELETE"],
  resizeSession: ["POST"],
  restartSession: ["POST"],
  stopSession: ["POST"],
  sessionAccess: ["POST"],
  sessionPiAuthSelection: ["POST"],
  gitStatus: ["GET"],
  gitPull: ["POST"],
  gitStage: ["POST"],
  gitUnstage: ["POST"],
  gitCommit: ["POST"],
  gitPush: ["POST"],
  gitOpenPr: ["POST"],
  piPackages: ["GET"],
  piPackageInstall: ["POST"],
  piPackageRemove: ["POST"],
  piPackageUpdate: ["POST"],
  piSkills: ["GET", "POST"],
  piSkillDelete: ["POST"],
  githubRepos: ["GET"],
  githubConnect: ["GET"],
});

function routeAllowsMethod(route, method) {
  if (String(method || "").toUpperCase() === "OPTIONS") return true;
  const methods = ROUTE_METHODS[route && route.name];
  return Boolean(methods && methods.includes(String(method || "").toUpperCase()));
}

function routeRequiresAuth(route, method) {
  const normalizedMethod = String(method || "").toUpperCase();
  if (normalizedMethod === "OPTIONS") return false;
  if (normalizedMethod === "POST" && route && route.name === "qaCustomToken") return false;
  return !(normalizedMethod === "GET" && route && route.name === "githubCallback");
}

module.exports = {
  OPENAI_CODEX_PROVIDER,
  ROUTE_METHODS,
  routeAllowsMethod,
  routeRequest,
  routeRequiresAuth,
};
