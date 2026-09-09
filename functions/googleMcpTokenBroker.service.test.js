"use strict";

const assert = require("assert");
const {createGoogleMcpTokenBrokerService, safeTokenEqual} = require("./googleMcpTokenBroker.service");

function request(body, token = "shutdown-a", method = "POST") {
  return {
    body,
    method,
    get: (name) => name === "x-shutdown-token" ? token : "",
  };
}

function serviceFor(overrides = {}) {
  const calls = [];
  const session = Object.prototype.hasOwnProperty.call(overrides, "session") ? overrides.session : {
    ownerUid: "user-a",
    shutdownToken: "shutdown-a",
    status: "running",
    workspaceId: "workspace-a",
  };
  const service = createGoogleMcpTokenBrokerService({
    sessionCollection: (workspaceId) => ({
      doc: (sessionId) => ({
        get: async () => {
          calls.push(["session", workspaceId, sessionId]);
          return {exists: Boolean(session), data: () => session};
        },
      }),
    }),
    connectionsService: {
      getGoogleWorkspaceBinding: async (uid, workspaceId) => {
        calls.push(["binding", uid, workspaceId]);
        return overrides.binding === undefined ? {connectionId: "connection-a"} : overrides.binding;
      },
    },
    oauthService: {
      refreshGoogleConnection: async (uid, connectionId) => {
        calls.push(["refresh", uid, connectionId]);
        return {accessToken: "access-fresh", expiresIn: 3600};
      },
    },
  });
  return {calls, service};
}

(async () => {
  assert.equal(safeTokenEqual("same", "same"), true);
  assert.equal(safeTokenEqual("same", "other"), false);
  assert.equal(safeTokenEqual("", ""), false);

  const success = serviceFor();
  assert.deepStrictEqual(await success.service.refreshAccessToken(request({
    workspaceId: "workspace-a",
    sessionId: "session-a",
    connectionId: "connection-a",
  })), {accessToken: "access-fresh", expiresIn: 3600});
  assert.deepStrictEqual(success.calls, [
    ["session", "workspace-a", "session-a"],
    ["binding", "user-a", "workspace-a"],
    ["refresh", "user-a", "connection-a"],
  ]);

  const unauthorized = serviceFor();
  await assert.rejects(
      unauthorized.service.refreshAccessToken(request({workspaceId: "workspace-a", sessionId: "session-a", connectionId: "connection-a"}, "wrong")),
      (error) => error.status === 404 && error.publicMessage === "not_found",
  );
  assert.deepStrictEqual(unauthorized.calls, [["session", "workspace-a", "session-a"]]);

  const stopped = serviceFor({session: {
    ownerUid: "user-a",
    shutdownToken: "shutdown-a",
    status: "stopped",
    workspaceId: "workspace-a",
  }});
  await assert.rejects(
      stopped.service.refreshAccessToken(request({workspaceId: "workspace-a", sessionId: "session-a", connectionId: "connection-a"})),
      (error) => error.status === 409 && error.publicMessage === "google_token_refresh_session_unavailable",
  );

  const rebound = serviceFor({binding: {connectionId: "connection-b"}});
  await assert.rejects(
      rebound.service.refreshAccessToken(request({workspaceId: "workspace-a", sessionId: "session-a", connectionId: "connection-a"})),
      (error) => error.status === 409 && error.publicMessage === "google_connection_reconnect_required",
  );
  assert.equal(rebound.calls.some(([name]) => name === "refresh"), false);

  await assert.rejects(
      serviceFor().service.refreshAccessToken(request({workspaceId: "workspace-a", sessionId: "session-a", connectionId: "connection-a"}, "shutdown-a", "GET")),
      (error) => error.status === 405,
  );
  console.log("google MCP token broker service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
