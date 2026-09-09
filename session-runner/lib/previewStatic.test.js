"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {createStaticPreviewService} = require("./previewStatic");

function createResponse() {
  return {
    body: null,
    filePath: null,
    headers: {},
    statusCode: 200,
    send(body) {
      this.body = body;
      return this;
    },
    sendFile(filePath) {
      this.filePath = filePath;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
  };
}

function request(pathname, accept = "") {
  return {
    get(name) {
      return name === "accept" ? accept : "";
    },
    mapacheAccessToken: "signed-token",
    params: [pathname],
  };
}

test("static preview serves assets, SPA fallback, and rejects traversal", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-preview-static-"));
  const staticRoot = path.join(workspaceDir, "build");
  await fs.mkdir(path.join(staticRoot, "assets"), {recursive: true});
  await fs.writeFile(path.join(staticRoot, "index.html"), "<h1>preview</h1>");
  await fs.writeFile(path.join(staticRoot, "assets", "app.js"), "console.log('preview');");
  const service = createStaticPreviewService({
    previewInjectLogger: false,
    previewStaticRoot: staticRoot,
    workspaceDir,
  });

  const assetResponse = createResponse();
  await service.serve(request("assets/app.js"), assetResponse, {staticRoot});
  assert.equal(assetResponse.filePath, path.join(staticRoot, "assets", "app.js"));
  assert.equal(assetResponse.headers["content-type"], "text/javascript; charset=utf-8");

  const fallbackResponse = createResponse();
  await service.serve(request("dashboard", "text/html"), fallbackResponse, {staticRoot});
  assert.equal(fallbackResponse.filePath, path.join(staticRoot, "index.html"));

  const traversalResponse = createResponse();
  await service.serve(request("../secrets.txt"), traversalResponse, {staticRoot});
  assert.equal(traversalResponse.statusCode, 400);
  assert.equal(traversalResponse.body, "invalid preview path");
});
