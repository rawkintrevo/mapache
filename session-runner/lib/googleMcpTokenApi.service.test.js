"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {createGoogleMcpTokenApiService} = require("./googleMcpTokenApi.service");

function request(socketPath, method = "POST", pathname = "/google/token") {
  return new Promise((resolve, reject) => {
    const req = http.request({socketPath, path: pathname, method}, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8"))}));
    });
    req.on("error", reject);
    req.end();
  });
}

test("brokers Google renewal through a private socket without exposing runner credentials", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-google-token-"));
  const socketPath = path.join(root, "google-token.sock");
  const calls = [];
  const service = createGoogleMcpTokenApiService({
    googleMcpTokenSocketPath: socketPath,
    googleMcpTokenRefreshUrl: "https://functions.example/googleMcpToken",
    googleMcpConnectionId: "connection-a",
    workspaceId: "workspace-a",
    sessionId: "session-a",
    shutdownToken: "runner-secret",
  }, {
    fetch: async (url, options) => {
      calls.push({url, options});
      return Response.json({accessToken: "fresh-token", expiresIn: 3600});
    },
  });
  try {
    await service.start();
    const result = await request(socketPath);
    assert.deepEqual(result, {status: 200, body: {accessToken: "fresh-token", expiresIn: 3600}});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers["x-shutdown-token"], "runner-secret");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      workspaceId: "workspace-a", sessionId: "session-a", connectionId: "connection-a",
    });
    assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600);
    const invalid = await request(socketPath, "GET");
    assert.equal(invalid.status, 405);
    await service.stop();
    await assert.rejects(fs.stat(socketPath), (error) => error.code === "ENOENT");
  } finally {
    await service.stop();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("returns broker reconnect errors without exposing provider payloads", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-google-token-"));
  const socketPath = path.join(root, "google-token.sock");
  const service = createGoogleMcpTokenApiService({
    googleMcpTokenSocketPath: socketPath,
    googleMcpTokenRefreshUrl: "https://functions.example/googleMcpToken",
    googleMcpConnectionId: "connection-a", workspaceId: "workspace-a", sessionId: "session-a", shutdownToken: "secret",
  }, {fetch: async () => Response.json({error: "google_connection_reconnect_required", detail: "private"}, {status: 409})});
  try {
    await service.start();
    assert.deepEqual(await request(socketPath), {status: 409, body: {error: "google_connection_reconnect_required"}});
  } finally {
    await service.stop();
    await fs.rm(root, {recursive: true, force: true});
  }
});
