"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {createHmac} = require("node:crypto");
const {createBrowserAccessVerifier} = require("./browserAccess");
const {createRemoteChromeAccess} = require("./remoteChromeAccess");

test("viewer assets and input require the active owner, workspace, session, boot and generation", () => {
  const claims = {sid: "s", gen: 4, uid: "owner", wid: "workspace", boot: "boot", aud: "agent", exp: 101};
  const agentAccess = createBrowserAccessVerifier({sessionId: "s", generation: 4, audience: "agent",
    requireGeneration: true, requireAudience: true, secret: "fixture", now: () => 100000});
  let current = true;
  const viewer = createRemoteChromeAccess({agentAccess, workspaceAuthority: {isCurrentWriter: () => current},
    config: {chromeEnabled: true, remoteGuestMode: true, workspaceId: "workspace", ownerUid: "owner",
      agentRuntimeBootInstanceId: "boot"}});
  function request(overrides = {}) {
    const body = Buffer.from(JSON.stringify({...claims, ...overrides})).toString("base64url");
    const signature = createHmac("sha256", "fixture").update(body).digest("base64url");
    return {headers: {cookie: `mapache_access=${body}.${signature}`}};
  }
  assert.equal(viewer.allowed(request()), true);
  for (const delta of [{sid: "old"}, {gen: 3}, {aud: "other"}, {uid: "other"}, {wid: "other"}, {boot: "old"}, {exp: 100}]) {
    assert.equal(viewer.allowed(request(delta)), false);
  }
  assert.equal(viewer.allowed({}), false);
  current = false;
  assert.equal(viewer.allowed(request()), false);
});
