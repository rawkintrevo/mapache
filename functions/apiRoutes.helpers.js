"use strict";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const {ROUTE_METHODS} = require("./apiRouteManifest");

function routeRequest(path) {
  const parts = String(path || "").replace(/^\/api\/?/, "/").split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "me") return {name: "me"};
  if (parts.length === 1 && parts[0] === "automation-schedule-preview") {
    return {name: "automationSchedulePreview"};
  }
  if (parts.length === 2 && parts[0] === "admin" && parts[1] === "users") {
    return {name: "adminUsers"};
  }
  if (
    parts.length === 4 &&
    parts[0] === "admin" &&
    parts[1] === "users" &&
    parts[3] === "whitelist"
  ) {
    return {name: "adminUserWhitelist", uid: parts[2]};
  }
  if (parts.length === 2 && parts[0] === "qa" && parts[1] === "custom-token") {
    return {name: "qaCustomToken"};
  }
  if (parts.length >= 2 && parts[0] === "public-previews") {
    return {
      name: "publicPreview",
      token: parts[1],
      path: parts.slice(2).join("/"),
    };
  }
  if (parts.length === 1 && parts[0] === "auth") return {name: "piAuth"};
  if (parts.length === 3 && parts[0] === "auth" && parts[1] === "providers") {
    return {name: "piAuthProvider", provider: parts[2]};
  }
  if (parts.length === 3 && parts[0] === "auth" && parts[1] === "entries") {
    return {name: "piAuthEntry", entryId: parts[2]};
  }
  if (parts.length === 2 && parts[0] === "auth" && parts[1] === "environment") return {name: "genericEnv"};
  if (parts.length === 3 && parts[0] === "auth" && parts[1] === "environment") {
    return {name: "genericEnvEntry", entryId: parts[2]};
  }
  if (
    parts.length === 5 &&
    parts[0] === "auth" &&
    parts[1] === "providers" &&
    parts[2] === OPENAI_CODEX_PROVIDER &&
    parts[3] === "device-code"
  ) {
    return {name: "openAiCodexDeviceCode", action: parts[4]};
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
  if (parts.length === 3 && parts[0] === "workspaces" && parts[2] === "mcp") {
    return {name: "workspaceMcp", workspaceId: parts[1]};
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
    ["long-running", "sessionLongRunning"],
    ["access-url", "sessionAccess"],
    ["logs", "sessionLogs"],
    ["share-preview", "sessionSharePreview"],
    ["auth-selection", "sessionPiAuthSelection"],
    ["pi-auth-selection", "sessionPiAuthSelection"],
  ]);
  if (parts.length === 5 && parts[0] === "workspaces" && parts[2] === "sessions") {
    const name = sessionActionRoutes.get(parts[4]);
    if (name) return {name, workspaceId: parts[1], sessionId: parts[3]};
  }

  if (
    parts.length === 6 &&
    parts[0] === "workspaces" &&
    parts[2] === "sessions" &&
    parts[4] === "qa" &&
    parts[5] === "faults"
  ) {
    return {name: "sessionQaFaults", workspaceId: parts[1], sessionId: parts[3]};
  }
  if (parts.length === 2 && parts[0] === "github" && parts[1] === "connect") {
    return {name: "githubConnect"};
  }
  if (parts.length === 2 && parts[0] === "github" && parts[1] === "connection") {
    return {name: "githubConnection"};
  }
  if (parts.length === 2 && parts[0] === "github" && parts[1] === "disconnect") {
    return {name: "githubDisconnect"};
  }
  if (parts.length === 2 && parts[0] === "github" && parts[1] === "callback") {
    return {name: "githubCallback"};
  }
  if (parts.length === 2 && parts[0] === "github" && parts[1] === "repos") {
    return {name: "githubRepos"};
  }
  if (parts.length === 2 && parts[0] === "google" && parts[1] === "callback") {
    return {name: "googleCallback"};
  }
  if (parts.length === 2 && parts[0] === "google" && parts[1] === "services") {
    return {name: "googleCatalog"};
  }
  if (parts.length === 2 && parts[0] === "google" && parts[1] === "connections") {
    return {name: "googleConnections"};
  }
  if (parts.length === 3 && parts[0] === "google" && parts[1] === "connections") {
    return {name: "googleConnection", connectionId: parts[2]};
  }
  if (parts.length === 3 && parts[0] === "workspaces" && parts[2] === "google") {
    return {name: "workspaceGoogle", workspaceId: parts[1]};
  }
  if (parts.length === 4 && parts[0] === "workspaces" && parts[2] === "google" && parts[3] === "connect") {
    return {name: "googleConnectionStart", workspaceId: parts[1]};
  }
  if (parts.length === 4 && parts[0] === "workspaces" && parts[2] === "google" && parts[3] === "binding") {
    return {name: "googleBinding", workspaceId: parts[1]};
  }
  return {name: "unknown"};
}

function routeAllowsMethod(route, method) {
  if (String(method || "").toUpperCase() === "OPTIONS") return true;
  const methods = ROUTE_METHODS[route && route.name];
  return Boolean(methods && methods.includes(String(method || "").toUpperCase()));
}

function routeRequiresAuth(route, method) {
  const normalizedMethod = String(method || "").toUpperCase();
  if (normalizedMethod === "OPTIONS") return false;
  if (normalizedMethod === "POST" && route && route.name === "qaCustomToken") return false;
  if (normalizedMethod === "GET" && route && route.name === "publicPreview") return false;
  return !(normalizedMethod === "GET" && route &&
    (route.name === "githubCallback" || route.name === "googleCallback"));
}

module.exports = {
  OPENAI_CODEX_PROVIDER,
  ROUTE_METHODS,
  routeAllowsMethod,
  routeRequest,
  routeRequiresAuth,
};
