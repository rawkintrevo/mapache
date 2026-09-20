"use strict";

const {routeAllowsMethod} = require("./apiRoutes.helpers");

function jsonResult(handler) {
  return async (context) => ({body: await handler(context)});
}

function createdJsonResult(handler) {
  return async (context) => ({status: 201, body: await handler(context)});
}

function namedJsonResult(name, handler) {
  return async (context) => ({body: {[name]: await handler(context)}});
}

function acceptedNamedJsonResult(name, handler) {
  return async (context) => ({status: 202, body: {[name]: await handler(context)}});
}

function createdNamedJsonResult(name, handler) {
  return async (context) => ({status: 201, body: {[name]: await handler(context)}});
}

const ROUTE_DISPATCHERS = Object.freeze({
  profile: Object.freeze([
    ["GET", "me", namedJsonResult("user", ({handlers, user}) => handlers.userWithUsage(user))],
    ["PATCH", "me", namedJsonResult("user", ({handlers, req, user}) => handlers.updateUserTimezone(user.uid, req.body || {}))],
  ]),
  automation: Object.freeze([
    ["POST", "automationSchedulePreview", jsonResult(({handlers, req}) => handlers.previewAutomationSchedule(req.body || {}))],
  ]),
  admin: Object.freeze([
    ["GET", "adminUsers", jsonResult(({handlers, req, user}) => handlers.listAdminUsers(user, req.query || {}))],
    ["POST", "adminUserWhitelist", namedJsonResult("user", ({handlers, req, route, user}) => (
      handlers.setAdminUserWhitelist(user, route.uid, Boolean(req.body && req.body.whitelisted))
    ))],
  ]),
  piAuth: Object.freeze([
    ["GET", "piAuth", jsonResult(({handlers, user}) => handlers.getPiAuth(user.uid))],
    ["PUT", "piAuthProvider", jsonResult(({handlers, req, route, user}) => handlers.savePiAuthProvider(user.uid, route.provider, req.body || {}))],
    ["DELETE", "piAuthProvider", jsonResult(({handlers, route, user}) => handlers.deletePiAuthProvider(user.uid, route.provider))],
    ["DELETE", "piAuthEntry", jsonResult(({handlers, route, user}) => handlers.deletePiAuthEntry(user.uid, route.entryId))],
    ["GET", "genericEnv", jsonResult(({handlers, user}) => handlers.listGenericEnvironmentKeys(user.uid))],
    ["POST", "genericEnv", createdJsonResult(({handlers, req, user}) => handlers.createGenericEnvironmentKey(user.uid, req.body || {}))],
    ["PUT", "genericEnvEntry", jsonResult(({handlers, req, route, user}) => handlers.updateGenericEnvironmentKey(user.uid, route.entryId, req.body || {}))],
    ["DELETE", "genericEnvEntry", jsonResult(({handlers, route, user}) => handlers.deleteGenericEnvironmentKey(user.uid, route.entryId))],
    ["POST", "openAiCodexDeviceCode", jsonResult(({handlers, req, route, user}) => {
      if (route.action === "start") return handlers.startOpenAiCodexDeviceCode();
      if (route.action === "complete") return handlers.completeOpenAiCodexDeviceCode(user.uid, req.body || {});
      return undefined;
    })],
  ]),
  workspaces: Object.freeze([
    ["GET", "workspaces", namedJsonResult("workspaces", ({handlers, user}) => handlers.listWorkspaces(user.uid))],
    ["POST", "workspaces", createdNamedJsonResult("workspace", ({handlers, req, user}) => handlers.createWorkspace(user.uid, req.body || {}))],
    ["PATCH", "workspace", namedJsonResult("workspace", ({handlers, req, route, user}) => handlers.renameWorkspace(user.uid, route.workspaceId, req.body || {}))],
    ["DELETE", "workspace", jsonResult(({handlers, route, user}) => handlers.deleteWorkspace(user.uid, route.workspaceId))],
    ["GET", "workspaceMcp", jsonResult(({handlers, route, user}) => handlers.getWorkspaceMcpConfig(user.uid, route.workspaceId))],
    ["PUT", "workspaceMcp", jsonResult(({handlers, req, route, user}) => handlers.saveWorkspaceMcpConfig(user.uid, route.workspaceId, req.body || {}))],
  ]),
  sessions: Object.freeze([
    ["GET", "sessions", namedJsonResult("sessions", ({handlers, route, user}) => handlers.listSessions(user.uid, route.workspaceId))],
    ["POST", "sessions", createdNamedJsonResult("session", ({handlers, req, route, user}) => handlers.createSession(user.uid, route.workspaceId, req.body || {}))],
    ["PATCH", "session", namedJsonResult("session", ({handlers, req, route, user}) => handlers.renameSession(user.uid, route.workspaceId, route.sessionId, req.body || {}))],
    ["PATCH", "sessionLongRunning", namedJsonResult("session", ({handlers, req, route, user}) => handlers.setSessionLongRunning(user.uid, route.workspaceId, route.sessionId, req.body || {}))],
    ["POST", "resizeSession", acceptedNamedJsonResult("session", ({handlers, req, route, user}) => handlers.resizeSession(user.uid, route.workspaceId, route.sessionId, req.body || {}))],
    ["POST", "restartSession", namedJsonResult("session", ({handlers, route, user}) => handlers.restartSession(user.uid, route.workspaceId, route.sessionId))],
    ["POST", "stopSession", namedJsonResult("session", ({handlers, route, user}) => handlers.stopSession(user.uid, route.workspaceId, route.sessionId))],
    ["DELETE", "session", jsonResult(({handlers, route, user}) => handlers.deleteSession(user.uid, route.workspaceId, route.sessionId))],
    ["POST", "sessionAccess", jsonResult(({handlers, route, user}) => handlers.createSessionAccessUrls(user.uid, route.workspaceId, route.sessionId))],
    ["GET", "sessionLogs", jsonResult(({handlers, req, route, user}) => handlers.listSessionLogs(user.uid, route.workspaceId, route.sessionId, req.query || {}))],
    ["GET", "sessionQaFaults", jsonResult(({handlers, route, user}) => handlers.getSessionQaFaults(user.uid, route.workspaceId, route.sessionId))],
    ["POST", "sessionQaFaults", jsonResult(({handlers, req, route, user}) => handlers.armSessionQaFault(user.uid, route.workspaceId, route.sessionId, req.body || {}))],
    ["POST", "sessionSharePreview", jsonResult(({handlers, req, route, user}) => handlers.shareSessionPreview(user.uid, route.workspaceId, route.sessionId, req))],
    ["POST", "sessionPiAuthSelection", jsonResult(({handlers, req, route, user}) => handlers.saveSessionPiAuthSelection(user.uid, route.workspaceId, route.sessionId, req.body || {}))],
  ]),
  github: Object.freeze([
    ["GET", "githubRepos", jsonResult(({handlers, user}) => handlers.listConnectedRepos(user.uid))],
    ["GET", "githubConnect", jsonResult(({handlers, req, user}) => handlers.createGithubConnectUrl(user.uid, req))],
    ["GET", "githubConnection", jsonResult(({handlers, user}) => handlers.getGithubConnection(user.uid))],
    ["POST", "githubDisconnect", jsonResult(({handlers, user}) => handlers.disconnectGithub(user.uid))],
  ]),
  google: Object.freeze([
    ["GET", "googleCatalog", jsonResult(({handlers}) => handlers.listGoogleWorkspaceServices())],
    ["GET", "googleConnections", jsonResult(({handlers, user}) => handlers.listGoogleConnections(user.uid))],
    ["GET", "googleConnection", jsonResult(({handlers, route, user}) => handlers.getGoogleConnection(user.uid, route.connectionId))],
    ["DELETE", "googleConnection", jsonResult(({handlers, route, user}) => handlers.deleteGoogleConnection(user.uid, route.connectionId))],
  ]),
  googleWorkspace: Object.freeze([
    ["GET", "workspaceGoogle", jsonResult(({handlers, route, user}) => handlers.getWorkspaceGoogleConnection(user.uid, route.workspaceId))],
    ["POST", "googleConnectionStart", jsonResult(({handlers, req, route, user}) => handlers.startGoogleConnection(user.uid, route.workspaceId, req.body || {}))],
    ["POST", "googleBinding", jsonResult(({handlers, req, route, user}) => handlers.bindWorkspaceGoogleConnection(user.uid, route.workspaceId, req.body || {}))],
    ["DELETE", "googleBinding", jsonResult(({handlers, route, user}) => handlers.unbindWorkspaceGoogleConnection(user.uid, route.workspaceId))],
  ]),
});

function findRouteDispatcher(method, routeName) {
  const normalizedMethod = String(method || "").toUpperCase();
  if (!routeAllowsMethod({name: routeName}, normalizedMethod)) return null;
  for (const group of Object.values(ROUTE_DISPATCHERS)) {
    for (const [entryMethod, entryRouteName, dispatcher] of group) {
      if (entryMethod === normalizedMethod && entryRouteName === routeName) return dispatcher;
    }
  }
  return null;
}

async function dispatchApiRoute({route, req, res, user, handlers}) {
  const dispatcher = findRouteDispatcher(req.method, route.name);
  if (!dispatcher) {
    res.status(404).json({error: "not_found"});
    return false;
  }
  const result = await dispatcher({route, req, res, user, handlers});
  if (!result || result.body === undefined) {
    res.status(404).json({error: "not_found"});
    return false;
  }
  res.status(result.status || 200).json(result.body);
  return true;
}

module.exports = {
  ROUTE_DISPATCHERS,
  dispatchApiRoute,
  findRouteDispatcher,
};
