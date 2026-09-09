"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {createN64PreviewService} = require("./previewN64");

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

function request(pathname) {
  return {
    get: () => "text/html",
    mapacheAccessToken: "signed-token",
    params: [pathname],
  };
}

test("N64 preview serves a signed emulator shell and ROM download", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-preview-n64-"));
  const romPath = path.join(workspaceDir, "build", "game.z64");
  await fs.mkdir(path.dirname(romPath), {recursive: true});
  await fs.writeFile(romPath, Buffer.alloc(4096));
  const service = createN64PreviewService({previewBasePath: "/preview", workspaceDir}, {
    previewLoggerScript: () => "<script>logger</script>",
  });
  const previewConfig = {emulatorCore: "parallel_n64", romPath};

  const htmlResponse = createResponse();
  await service.serve(request("index.html"), htmlResponse, previewConfig);
  assert.equal(htmlResponse.headers["content-type"], "text/html; charset=utf-8");
  assert.match(htmlResponse.body, /Mapache N64 Preview/);
  assert.match(htmlResponse.body, /parallel-n64/);
  assert.match(htmlResponse.body, /rom\.z64\?mapache_access=signed-token/);
  assert.match(htmlResponse.body, /logger/);

  const romResponse = createResponse();
  await service.serve(request("rom.z64"), romResponse, previewConfig);
  assert.equal(romResponse.filePath, romPath);
  assert.equal(romResponse.headers["content-type"], "application/octet-stream");
  assert.equal(romResponse.headers["content-disposition"], 'inline; filename="game.z64"');
});

test("N64 preview normalizes safe ROM paths and emulator cores", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-preview-n64-"));
  const service = createN64PreviewService({workspaceDir});
  assert.equal(service.normalizeRomPath("build/game.z64"), path.join(workspaceDir, "build/game.z64"));
  assert.equal(service.normalizeRomPath("../game.z64"), "");
  assert.equal(service.normalizeRomPath("build/game.iso"), "");
  assert.equal(service.normalizeEmulatorCore("parallel_n64"), "parallel-n64");
  assert.equal(service.normalizeEmulatorCore("unknown"), "n64");
});
