"use strict";

function jsonResult(handler) {
  return async (context) => ({body: await handler(context)});
}

function createdJsonResult(handler) {
  return async (context) => ({status: 201, body: await handler(context)});
}

function namedJsonResult(name, handler) {
  return async (context) => ({body: {[name]: await handler(context)}});
}

function createdNamedJsonResult(name, handler) {
  return async (context) => ({status: 201, body: {[name]: await handler(context)}});
}

const ROUTE_DISPATCHERS = Object.freeze({
  profile: Object.freeze([
    ["GET", "me", namedJsonResult("user", ({handlers, user}) => handlers.userWithUsage(user))],
  ]),
  piAuth: Object.freeze([
    ["GET", "piAuth", jsonResult(({handlers, user}) => handlers.getPiAuth(user.uid))],
    ["PUT", "piAuthProvider", jsonResult(({handlers, req, route, user}) => handlers.savePiAuthProvider(user.uid, route.provider, req.body || {}))],
    ["DELETE", "piAuthProvider", jsonResult(({handlers, route, user}) => handlers.deletePiAuthProvider(user.uid, route.provider))],
    ["DELETE", "piAuthEntry", jsonResult(({handlers, route, user}) => handlers.deletePiAuthEntry(user.uid, route.entryId))],
    ["POST", "openAiCodexDeviceCode", jsonResult(({handlers, req, route, user}) => {
      if (route.action === "start") return handlers.startOpenAiCodexDeviceCode();
      if (route.action === "complete") return handlers.completeOpenAiCodexDeviceCode(user.uid, req.body || {});
      return undefined;
    })],
  ]),
  workspaces: Object.freeze([
    ["GET", "workspaces", namedJsonResult("workspaces", ({handlers, user}) => handlers.listWorkspaces(user.uid))],
    ["POST", "workspaces", createdNamedJsonResult("workspace", ({handlers, req, user}) => handlers.createWorkspace(user.uid, req.body || {}))],
    ["DELETE", "workspace", jsonResult(({handlers, route, user}) => handlers.deleteWorkspace(user.uid, route.workspaceId))],
    ["GET", "workspaceFiles", jsonResult(({handlers, route, user}) => handlers.listWorkspaceFiles(user.uid, route.workspaceId))],
    ["GET", "workspaceFile", jsonResult(({handlers, req, route, user}) => handlers.readWorkspaceFile(user.uid, route.workspaceId, req.query.path))],
    ["PUT", "workspaceFile", jsonResult(({handlers, req, route, user}) => handlers.saveWorkspaceFile(user.uid, route.workspaceId, req.query.path, req.body || {}))],
    ["POST", "workspaceFile", createdJsonResult(({handlers, req, route, user}) => handlers.uploadWorkspaceFile(user.uid, route.workspaceId, req.query.path, req))],
    ["POST", "workspaceFileDownloadUrl", jsonResult(({handlers, req, route, user}) => handlers.createWorkspaceFileDownloadUrl(user.uid, route.workspaceId, req.query.path))],
  ]),
  sessions: Object.freeze([
    ["GET", "sessions", namedJsonResult("sessions", ({handlers, route, user}) => handlers.listSessions(user.uid, route.workspaceId))],
    ["POST", "sessions", createdNamedJsonResult("session", ({handlers, req, route, user}) => handlers.createSession(user.uid, route.workspaceId, req.body || {}))],
    ["POST", "resizeSession", namedJsonResult("session", ({handlers, req, route, user}) => handlers.resizeSession(user.uid, route.workspaceId, route.sessionId, req.body || {}))],
    ["POST", "restartSession", namedJsonResult("session", ({handlers, route, user}) => handlers.restartSession(user.uid, route.workspaceId, route.sessionId))],
    ["POST", "stopSession", namedJsonResult("session", ({handlers, route, user}) => handlers.stopSession(user.uid, route.workspaceId, route.sessionId))],
    ["DELETE", "session", jsonResult(({handlers, route, user}) => handlers.deleteSession(user.uid, route.workspaceId, route.sessionId))],
    ["POST", "sessionAccess", jsonResult(({handlers, route, user}) => handlers.createSessionAccessUrls(user.uid, route.workspaceId, route.sessionId))],
    ["POST", "sessionPiAuthSelection", jsonResult(({handlers, req, route, user}) => handlers.saveSessionPiAuthSelection(user.uid, route.workspaceId, route.sessionId, req.body || {}))],
  ]),
  git: Object.freeze([
    ["GET", "gitStatus", jsonResult(({handlers, route, user}) => handlers.getGitStatusSummary(user.uid, route.workspaceId, route.sessionId))],
    ["POST", "gitPull", jsonResult(({handlers, route, user}) => handlers.pullGit(user.uid, route.workspaceId, route.sessionId))],
    ["POST", "gitStage", jsonResult(({handlers, req, route, user}) => handlers.stageGit(user.uid, route.workspaceId, route.sessionId, req.body || {}))],
    ["POST", "gitUnstage", jsonResult(({handlers, req, route, user}) => handlers.unstageGit(user.uid, route.workspaceId, route.sessionId, req.body || {}))],
    ["POST", "gitCommit", jsonResult(({handlers, req, route, user}) => handlers.commitGit(user.uid, route.workspaceId, route.sessionId, req.body || {}))],
    ["POST", "gitPush", jsonResult(({handlers, route, user}) => handlers.pushGit(user.uid, route.workspaceId, route.sessionId))],
    ["POST", "gitOpenPr", jsonResult(({handlers, req, route, user}) => handlers.openPullRequest(user.uid, route.workspaceId, route.sessionId, req.body || {}))],
  ]),
  piPackages: Object.freeze([
    ["GET", "piPackages", jsonResult(({handlers, route, user}) => handlers.listPiPackages(user.uid, route.workspaceId, route.sessionId))],
    ["POST", "piPackageInstall", jsonResult(({handlers, req, route, user}) => handlers.installPiPackage(user.uid, route.workspaceId, route.sessionId, req.body || {}))],
    ["POST", "piPackageRemove", jsonResult(({handlers, req, route, user}) => handlers.removePiPackage(user.uid, route.workspaceId, route.sessionId, req.body || {}))],
    ["POST", "piPackageUpdate", jsonResult(({handlers, req, route, user}) => handlers.updatePiPackage(user.uid, route.workspaceId, route.sessionId, req.body || {}))],
  ]),
  piSkills: Object.freeze([
    ["GET", "piSkills", jsonResult(({handlers, route, user}) => handlers.listPiSkills(user.uid, route.workspaceId, route.sessionId))],
    ["POST", "piSkills", jsonResult(({handlers, req, route, user}) => handlers.savePiSkill(user.uid, route.workspaceId, route.sessionId, req.body || {}))],
    ["POST", "piSkillDelete", jsonResult(({handlers, req, route, user}) => handlers.deletePiSkill(user.uid, route.workspaceId, route.sessionId, req.body || {}))],
  ]),
  github: Object.freeze([
    ["GET", "githubRepos", jsonResult(({handlers, user}) => handlers.listConnectedRepos(user.uid))],
    ["GET", "githubConnect", jsonResult(({handlers, req, user}) => handlers.createGithubConnectUrl(user.uid, req))],
  ]),
});

function findRouteDispatcher(method, routeName) {
  const normalizedMethod = String(method || "").toUpperCase();
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
