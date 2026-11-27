"use strict";

const {parsePayload} = require("./browserAccess");

function createRemoteChromeAccess({config, agentAccess, workspaceAuthority}) {
  function allowed(req) {
    if (!config.remoteGuestMode || !config.chromeEnabled || !workspaceAuthority.isCurrentWriter()) return false;
    const token = agentAccess.extractToken(req);
    if (!agentAccess.verify(token)) return false;
    const claims = parsePayload(token.split(".")[0]);
    return claims.wid === config.workspaceId && claims.uid === config.ownerUid &&
      claims.boot === config.agentRuntimeBootInstanceId;
  }

  function requireAccess(req, res, next) {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    if (!allowed(req)) return res.status(404).end();
    next();
  }

  return {allowed, requireAccess};
}

module.exports = {createRemoteChromeAccess};
