"use strict";

// Authenticated API route methods live here so route validation and dispatch
// tests share one contract. Public callback/preview routes remain explicit
// special cases in index.js.
const ROUTE_METHODS = Object.freeze(Object.fromEntries([
  ["githubCallback", ["GET"]],
  ["googleCallback", ["GET"]],
  ["me", ["GET", "PATCH"]],
  ["automationSchedulePreview", ["POST"]],
  ["automations", ["GET", "POST"]],
  ["automation", ["GET", "PATCH", "DELETE"]],
  ["automationRun", ["POST"]],
  ["automationSettings", ["GET", "PATCH"]],
  ["automationRunRestart", ["POST"]],
  ["automationRunCancel", ["POST"]],
  ["automationRuns", ["GET"]],
  ["automationRunDetail", ["GET"]],
  ["automationRunEvents", ["GET"]],
  ["automationStoragePrepare", ["POST"]],
  ["adminUsers", ["GET"]],
  ["adminUserWhitelist", ["POST"]],
  ["qaCustomToken", ["POST"]],
  ["publicPreview", ["GET"]],
  ["piAuth", ["GET"]],
  ["piAuthProvider", ["PUT", "DELETE"]],
  ["piAuthEntry", ["DELETE"]],
  ["genericEnv", ["GET", "POST"]],
  ["genericEnvEntry", ["PUT", "DELETE"]],
  ["openAiCodexDeviceCode", ["POST"]],
  ["workspaces", ["GET", "POST"]],
  ["workspace", ["PATCH", "DELETE"]],
  ["workspaceMcp", ["GET", "PUT"]],
  ["sessions", ["GET", "POST"]],
  ["session", ["PATCH", "DELETE"]],
  ["sessionLongRunning", ["PATCH"]],
  ["resizeSession", ["POST"]],
  ["restartSession", ["POST"]],
  ["stopSession", ["POST"]],
  ["sessionAccess", ["POST"]],
  ["sessionLogs", ["GET"]],
  ["sessionSharePreview", ["POST"]],
  ["sessionPiAuthSelection", ["POST"]],
  ["sessionQaFaults", ["GET", "POST"]],
  ["githubRepos", ["GET"]],
  ["githubConnect", ["GET"]],
  ["githubConnection", ["GET"]],
  ["githubDisconnect", ["POST"]],
  ["googleCatalog", ["GET"]],
  ["googleConnections", ["GET"]],
  ["googleConnection", ["GET", "DELETE"]],
  ["workspaceGoogle", ["GET"]],
  ["googleConnectionStart", ["POST"]],
  ["googleBinding", ["POST", "DELETE"]],
].map(([name, methods]) => [name, Object.freeze(methods)])));

const SPECIAL_ROUTE_NAMES = Object.freeze(["githubCallback", "googleCallback", "qaCustomToken", "publicPreview"]);

module.exports = {ROUTE_METHODS, SPECIAL_ROUTE_NAMES};
