"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {createPreviewService} = require("./preview");
const {createPreviewShareService} = require("./previewShare.service");

function previewConfig(workspaceDir) {
  return {
    previewBasePath: "/preview",
    previewConfigPath: path.join(workspaceDir, ".mapache", "preview.json"),
    previewEnabled: true,
    previewInjectLogger: false,
    previewLogLimit: 10,
    previewN64RomPath: path.join(workspaceDir, "build", "game.z64"),
    previewStaticRoot: path.join(workspaceDir, "build"),
    runnerCapabilities: {preview: true, n64: false},
    workspaceDir,
  };
}

function mockStorage(uploaded) {
  return {
    bucket(bucketName) {
      return {
        upload(sourcePath, options) {
          uploaded.push({bucketName, sourcePath, options});
          return Promise.resolve();
        },
      };
    },
  };
}

test("shareStaticBuild uploads files under the configured static root", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-preview-"));
  await fs.mkdir(path.join(workspaceDir, "build", "assets"), {recursive: true});
  await fs.writeFile(path.join(workspaceDir, "build", "index.html"), "<h1>Hi</h1>");
  await fs.writeFile(path.join(workspaceDir, "build", "assets", "app.js"), "console.log('hi');");

  const uploaded = [];
  const config = previewConfig(workspaceDir);
  const previewShare = createPreviewShareService();
  const result = await previewShare.shareStaticBuild(mockStorage(uploaded), {
    bucketName: "bucket-1",
    storagePrefix: "/public-previews/token-1/",
  }, config.previewStaticRoot);

  assert.equal(result.ok, true);
  assert.equal(result.fileCount, 2);
  assert.equal(result.storagePrefix, "public-previews/token-1");
  assert.deepEqual(uploaded.map((entry) => entry.options.destination).sort(), [
    "public-previews/token-1/assets/app.js",
    "public-previews/token-1/index.html",
  ]);
  assert.equal(uploaded.find((entry) => entry.options.destination.endsWith(".js")).options.metadata.contentType, "text/javascript; charset=utf-8");
});

test("shareStaticBuild rejects missing and non-static preview output", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-preview-"));
  const config = previewConfig(workspaceDir);
  const previewShare = createPreviewShareService();

  await assert.rejects(
      () => previewShare.shareStaticBuild(mockStorage([]), {bucketName: "bucket-1", storagePrefix: "preview"}, config.previewStaticRoot),
      (error) => error.publicMessage === "preview_static_build_not_ready",
  );

  await fs.mkdir(path.join(workspaceDir, ".mapache"), {recursive: true});
  await fs.writeFile(path.join(workspaceDir, ".mapache", "preview.json"), JSON.stringify({
    mode: "proxy",
    upstream: "http://127.0.0.1:3000",
  }));
  const preview = createPreviewService(config);

  await assert.rejects(
      () => preview.shareStaticBuild(mockStorage([]), {bucketName: "bucket-1", storagePrefix: "preview"}),
      (error) => error.publicMessage === "preview_share_requires_static_build",
  );
});

test("status includes browser QA readiness when the service is provided", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-preview-"));
  await fs.mkdir(path.join(workspaceDir, "build"), {recursive: true});
  await fs.writeFile(path.join(workspaceDir, "build", "index.html"), "<h1>Hi</h1>");

  const preview = createPreviewService(previewConfig(workspaceDir), {
    browserQa: {
      capabilityStatus() {
        return {available: true, command: "mapache-preview-qa"};
      },
      status(previewStatus) {
        return {available: true, state: previewStatus.ready ? "browser_ready" : "preview_not_running"};
      },
    },
  });

  const status = await preview.status();
  assert.equal(status.qa.state, "browser_ready");
  assert.equal(status.qa.available, true);
  assert.equal(preview.capabilityStatus().qa.command, "mapache-preview-qa");
});

test("preview facade selects configured N64 and proxy modes", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-preview-"));
  const config = {
    ...previewConfig(workspaceDir),
    runnerCapabilities: {preview: true, n64: true},
  };
  await fs.mkdir(path.dirname(config.previewConfigPath), {recursive: true});
  await fs.mkdir(path.dirname(config.previewN64RomPath), {recursive: true});
  await fs.writeFile(config.previewN64RomPath, Buffer.alloc(128));
  const preview = createPreviewService(config);

  await fs.writeFile(config.previewConfigPath, JSON.stringify({
    core: "parallel_n64",
    mode: "n64",
  }));
  const n64Status = await preview.status();
  assert.equal(n64Status.mode, "n64");
  assert.equal(n64Status.ready, true);
  assert.equal(n64Status.n64.emulatorCore, "parallel-n64");

  await fs.writeFile(config.previewConfigPath, JSON.stringify({
    mode: "proxy",
    upstream: "http://127.0.0.1:1",
  }));
  const proxyStatus = await preview.status();
  assert.equal(proxyStatus.mode, "proxy");
  assert.equal(proxyStatus.ready, false);
});
