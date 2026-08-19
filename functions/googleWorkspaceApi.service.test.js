"use strict";

const assert = require("assert");
const {createGoogleWorkspaceApiService} = require("./googleWorkspaceApi.service");
const {googleWorkspaceServiceCatalog} = require("./googleWorkspace.catalog");

const calls = [];
const connection = {connectionId: "google-1", email: "person@example.com", status: "connected"};
const connectionsService = {
  async listGoogleConnections(uid) { calls.push(["list", uid]); return {connections: [connection]}; },
  async getGoogleConnection(uid, id) { calls.push(["get", uid, id]); return connection; },
  async getGoogleWorkspaceBinding(uid, workspaceId) {
    calls.push(["binding", uid, workspaceId]);
    return {connectionId: "google-1", enabledServices: ["drive"]};
  },
  async deleteGoogleConnection(uid, id) { calls.push(["delete", uid, id]); return {ok: true, connectionId: id}; },
  async bindGoogleWorkspaceConnection(uid, workspaceId, payload) {
    calls.push(["bind", uid, workspaceId, payload]); return payload;
  },
  async unbindGoogleWorkspaceConnection(uid, workspaceId) {
    calls.push(["unbind", uid, workspaceId]); return {ok: true};
  },
};
const oauthService = {
  async revokeGoogleConnection(uid, id) { calls.push(["revoke", uid, id]); },
  async startGoogleConnection(uid, workspaceId, payload) { return {uid, workspaceId, payload}; },
  async completeGoogleConnection(query) { return {query}; },
};

const workspaces = [
  {id: "workspace-1", name: "One", ownerUid: "user-1", googleWorkspaceBinding: {connectionId: "google-1"}},
  {id: "workspace-2", name: "Two", ownerUid: "user-1"},
  {id: "workspace-3", name: "Other", ownerUid: "user-2", googleWorkspaceBinding: {connectionId: "google-1"}},
];
const db = {collection() { return {where(_field, _operator, value) { return {async get() {
  return {docs: workspaces.filter((item) => item.ownerUid === value)
      .map((item) => ({id: item.id, data: () => item}))};
}}; }}; }};

(async () => {
  const service = createGoogleWorkspaceApiService({
    connectionsService,
    oauthService,
    db,
    requireWorkspace: async () => {},
  });
  assert.deepStrictEqual(await service.listGoogleConnections("user-1"), {connections: [connection]});
  assert.deepStrictEqual(await service.getGoogleConnection("user-1", "google-1"), {
    connection,
    workspaceUsage: {count: 1, workspaces: [{id: "workspace-1", name: "One"}]},
  });
  assert.deepStrictEqual(await service.getWorkspaceGoogleConnection("user-1", "workspace-1"), {
    binding: {connectionId: "google-1", enabledServices: ["drive"]},
    connection,
    services: googleWorkspaceServiceCatalog(),
  });
  await service.deleteGoogleConnection("user-1", "google-1");
  assert.deepStrictEqual(calls.slice(-2), [["revoke", "user-1", "google-1"], ["delete", "user-1", "google-1"]]);
  console.log("google workspace API service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
