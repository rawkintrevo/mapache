"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {authorizeGatewayRequest, gatewayTargetForSession, CANONICAL_HEALTH_PATH} = require("./runtimeGateway.helpers");

const base = {workspace: {id: "workspace-1", ownerUid: "owner-1"}, session: {id: "session-1", agentRuntimeGeneration: 4}};

test("gateway authorization binds owner, session, and generation", () => {
  const result = authorizeGatewayRequest({...base, claims: {uid: "owner-1", workspaceId: "workspace-1", sessionId: "session-1", generation: 4}, path: CANONICAL_HEALTH_PATH});
  assert.equal(result.health, true);
  assert.equal(result.upstream, null);
});

test("stale generations and reserved health paths are denied", () => {
  assert.throws(() => authorizeGatewayRequest({...base, claims: {uid: "owner-1", workspaceId: "workspace-1", sessionId: "session-1", generation: 3}}), /stale_generation/);
  assert.throws(() => authorizeGatewayRequest({...base, claims: {uid: "owner-1", workspaceId: "workspace-1", sessionId: "session-1", generation: 4}, path: "/healthz"}), /not_found/);
  assert.equal(gatewayTargetForSession({runtimeProvider: {gateway: {baseUrl: "https://gateway.example"}}}), "https://gateway.example");
});
