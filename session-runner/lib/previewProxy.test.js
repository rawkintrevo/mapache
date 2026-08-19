"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const {createProxyPreviewService} = require("./previewProxy");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("proxy preview forwards base path, query, method, and no-store headers", async () => {
  const upstream = http.createServer((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/app/dashboard?tab=logs");
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      assert.equal(body, JSON.stringify({hello: "world"}));
      res.writeHead(201, {"content-type": "application/json"});
      res.end(JSON.stringify({ok: true}));
    });
  });
  const upstreamPort = await listen(upstream);
  const service = createProxyPreviewService({previewBasePath: "/preview"});
  const proxy = http.createServer((req, res) => {
    req.body = {hello: "world"};
    req.params = ["dashboard"];
    service.serve(req, res, {upstream: `http://127.0.0.1:${upstreamPort}/app`});
  });
  const proxyPort = await listen(proxy);

  try {
    const response = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: "127.0.0.1",
        method: "POST",
        path: "/preview/dashboard?tab=logs",
        port: proxyPort,
      }, (res) => {
        let body = "";
        res.on("data", (chunk) => body += chunk);
        res.on("end", () => resolve({body, headers: res.headers, statusCode: res.statusCode}));
      });
      request.on("error", reject);
      request.end(JSON.stringify({hello: "world"}));
    });

    assert.equal(response.statusCode, 201);
    assert.deepEqual(JSON.parse(response.body), {ok: true});
    assert.equal(response.headers["cache-control"], "no-store");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("proxy preview readiness reports unavailable upstreams", async () => {
  const service = createProxyPreviewService({previewBasePath: "/preview"});
  assert.equal(await service.isReady("http://127.0.0.1:1"), false);
  assert.equal(service.normalizeUpstream("https://example.com"), "");
});
