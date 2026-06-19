"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {createPreviewService} = require("./preview");

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
  const preview = createPreviewService(previewConfig(workspaceDir));
  const result = await preview.shareStaticBuild(mockStorage(uploaded), {
    bucketName: "bucket-1",
    storagePrefix: "/public-previews/token-1/",
  });

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
  const preview = createPreviewService(previewConfig(workspaceDir));

  await assert.rejects(
      () => preview.shareStaticBuild(mockStorage([]), {bucketName: "bucket-1", storagePrefix: "preview"}),
      (error) => error.publicMessage === "preview_static_build_not_ready",
  );

  await fs.mkdir(path.join(workspaceDir, ".mapache"), {recursive: true});
  await fs.writeFile(path.join(workspaceDir, ".mapache", "preview.json"), JSON.stringify({
    mode: "proxy",
    upstream: "http://127.0.0.1:3000",
  }));

  await assert.rejects(
      () => preview.shareStaticBuild(mockStorage([]), {bucketName: "bucket-1", storagePrefix: "preview"}),
      (error) => error.publicMessage === "preview_share_requires_static_build",
  );
});
