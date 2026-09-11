"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const express = require("express");
const test = require("node:test");
const {
  createAgentGateway,
  mapPublicPath,
} = require("./agentGateway");
const {createBrowserAccessVerifier} = require("./browserAccess");

function signedToken(secret, claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function request(port, pathname, {method = "GET", headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      method,
      path: pathname,
      port,
      headers,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: res.headers,
        status: res.statusCode,
      }));
    });
    req.once("error", reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

async function createRuntime({requestLimitBytes = 10 * 1024 * 1024, assertCurrentWriter} = {}) {
  const secret = "agent-gateway-secret";
  const now = 1_700_000_000_000;
  const token = signedToken(secret, {
    aud: "agent",
    exp: now / 1000 + 60,
    gen: "7",
    sid: "session-1",
  });
  const verifier = createBrowserAccessVerifier({
    audience: "agent",
    generation: "7",
    now: () => now,
    requireAudience: true,
    requireGeneration: true,
    secret,
    sessionId: "session-1",
  });
  const upstreamRequests = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      upstreamRequests.push({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: req.headers,
        method: req.method,
        url: req.url,
      });
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/") {
        res.setHeader("Set-Cookie", "pi_web_token=private-upstream-cookie; Path=/");
        res.end("<html>agent</html>");
        return;
      }
      if (url.pathname === "/api/file") {
        res.statusCode = 206;
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Range", "bytes 0-3/8");
        res.end("file");
        return;
      }
      if (url.pathname === "/redirect-safe") {
        res.statusCode = 302;
        res.setHeader("Location", "/api/health?mapache_access=leak");
        res.end();
        return;
      }
      if (url.pathname === "/redirect-off-origin") {
        res.statusCode = 302;
        res.setHeader("Location", "https://evil.example/steal");
        res.end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ok: true, url: req.url}));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const app = express();
  const gateway = createAgentGateway({
    accessVerifier: verifier,
    getUpstreamHeaders: () => ({"x-pi-token": "private-upstream-token"}),
    requestLimitBytes,
    assertCurrentWriter,
    secureCookie: true,
    upstreamHost: "127.0.0.1",
    upstreamPort: upstream.address().port,
  });
  app.use("/agent", gateway.handle);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => upstream.close(resolve));
    },
    gateway,
    port: server.address().port,
    token,
    upstreamRequests,
  };
}

test("rejects state-changing requests after writer authority is lost", async () => {
  let admitted = true;
  const runtime = await createRuntime({
    assertCurrentWriter: async () => {
      if (!admitted) throw new Error("workspace_writer_authority_lost");
    },
  });
  try {
    admitted = false;
    const tokenCookie = `mapache_access=${encodeURIComponent(runtime.token)}`;
    const response = await request(runtime.port, "/agent/plugins-api/test/hook", {
      headers: {
        cookie: tokenCookie,
        origin: `http://127.0.0.1:${runtime.port}`,
      },
      method: "POST",
      body: "stale-work",
    });
    assert.equal(response.status, 503);
    assert.equal(runtime.upstreamRequests.length, 0);
  } finally {
    await runtime.close();
  }
});

test("maps the public prefix and removes auth query parameters", () => {
  assert.equal(mapPublicPath("/agent/"), "/");
  assert.equal(mapPublicPath("/agent/api/file"), "/api/file");
  assert.equal(mapPublicPath("/other"), "/other");
});

test("authenticates bootstrap, scopes the cookie, and streams a Range response without leaking credentials", async () => {
  const runtime = await createRuntime();
  try {
    const bootstrap = await request(runtime.port, `/agent/?mapache_access=${encodeURIComponent(runtime.token)}&next=1`);
    assert.equal(bootstrap.status, 303);
    assert.equal(bootstrap.headers.location, "/agent/?next=1");
    assert.match(bootstrap.headers["set-cookie"][0], /Path=\/agent\//);
    assert.match(bootstrap.headers["set-cookie"][0], /HttpOnly/);
    assert.match(bootstrap.headers["set-cookie"][0], /SameSite=None/);
    assert.match(bootstrap.headers["set-cookie"][0], /Secure/);
    assert.match(bootstrap.headers["set-cookie"][0], /Partitioned/);
    assert.equal(runtime.upstreamRequests.length, 0);

    const cookie = `mapache_access=${encodeURIComponent(runtime.token)}`;
    const root = await request(runtime.port, "/agent/", {headers: {cookie}});
    assert.equal(root.status, 200);
    assert.equal(root.body, "<html>agent</html>");
    assert.equal(root.headers["set-cookie"], undefined);
    assert.equal(runtime.upstreamRequests[0].headers.cookie, undefined);
    assert.equal(runtime.upstreamRequests[0].headers.authorization, undefined);
    assert.equal(runtime.upstreamRequests[0].headers["x-pi-token"], "private-upstream-token");

    const range = await request(runtime.port, `/agent/api/file?path=asset.mp4&mapache_access=${encodeURIComponent(runtime.token)}`, {
      headers: {cookie, range: "bytes=0-3"},
    });
    assert.equal(range.status, 206);
    assert.equal(range.body, "file");
    assert.equal(range.headers["content-range"], "bytes 0-3/8");
    assert.equal(runtime.upstreamRequests[1].url, "/api/file?path=asset.mp4");
    assert.equal(runtime.upstreamRequests[1].headers.range, "bytes=0-3");
  } finally {
    await runtime.close();
  }
});

test("streams mutation bodies only for the exact Origin and enforces the upstream body limit", async () => {
  const runtime = await createRuntime({requestLimitBytes: 8});
  try {
    const cookie = `mapache_access=${encodeURIComponent(runtime.token)}`;
    const missingOrigin = await request(runtime.port, "/agent/plugins-api/test/hook", {
      headers: {cookie, "content-type": "application/json"},
      method: "POST",
      body: "payload",
    });
    assert.equal(missingOrigin.status, 403);

    const foreignOrigin = await request(runtime.port, "/agent/plugins-api/test/hook", {
      headers: {cookie, origin: "https://foreign.example", "content-type": "application/json"},
      method: "POST",
      body: "payload",
    });
    assert.equal(foreignOrigin.status, 403);

    const hostOrigin = `http://127.0.0.1:${runtime.port}`;
    const valid = await request(runtime.port, "/agent/plugins-api/test/hook", {
      headers: {cookie, origin: hostOrigin, "content-type": "application/json"},
      method: "POST",
      body: "payload",
    });
    assert.equal(valid.status, 200);
    assert.equal(runtime.upstreamRequests.at(-1).body, "payload");
    assert.equal(runtime.upstreamRequests.at(-1).headers.origin, undefined);

    const oversized = await request(runtime.port, "/agent/plugins-api/test/hook", {
      headers: {cookie, origin: hostOrigin, "content-type": "application/json"},
      method: "POST",
      body: "123456789",
    });
    assert.equal(oversized.status, 413);
    assert.equal(runtime.upstreamRequests.length, 1);
  } finally {
    await runtime.close();
  }
});

test("rejects invalid access, traversal, and off-origin upstream redirects before exposing the upstream", async () => {
  const runtime = await createRuntime();
  try {
    const invalid = await request(runtime.port, "/agent/api/health");
    assert.equal(invalid.status, 404);
    assert.equal(runtime.upstreamRequests.length, 0);

    const wrongAudience = signedToken("agent-gateway-secret", {
      aud: "browser",
      exp: 1_700_000_060,
      gen: "7",
      sid: "session-1",
    });
    assert.equal((await request(runtime.port, `/agent/api/health?mapache_access=${wrongAudience}`)).status, 404);
    const wrongGeneration = signedToken("agent-gateway-secret", {
      aud: "agent",
      exp: 1_700_000_060,
      gen: "8",
      sid: "session-1",
    });
    assert.equal((await request(runtime.port, `/agent/api/health?mapache_access=${wrongGeneration}`)).status, 404);
    assert.equal(runtime.upstreamRequests.length, 0);

    const traversal = await request(runtime.port, "/agent/api/%2e%2e/secret", {
      headers: {cookie: `mapache_access=${encodeURIComponent(runtime.token)}`},
    });
    assert.equal(traversal.status, 400);
    assert.equal(runtime.upstreamRequests.length, 0);

    const cookie = `mapache_access=${encodeURIComponent(runtime.token)}`;
    const safe = await request(runtime.port, "/agent/redirect-safe", {headers: {cookie}});
    assert.equal(safe.status, 302);
    assert.equal(safe.headers.location, "/agent/api/health");

    const offOrigin = await request(runtime.port, "/agent/redirect-off-origin", {headers: {cookie}});
    assert.equal(offOrigin.status, 502);
    assert.equal(offOrigin.headers.location, undefined);
    assert.doesNotMatch(offOrigin.body, /evil\.example/);
  } finally {
    await runtime.close();
  }
});
