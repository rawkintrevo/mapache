"use strict";

const assert = require("node:assert/strict");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  ADAPTER_PROTOCOL,
  DEFAULT_ADAPTER_REVISION,
  createPiWebFirstAdapter,
  validateHandshake,
} = require("./piWebFirstAdapter");

function validHandshake(overrides = {}) {
  return {
    type: "handshake",
    protocol: ADAPTER_PROTOCOL,
    runtime: "pi-tui-extension",
    pid: 123,
    sessionGeneration: 1,
    piSession: "pi-session-fixture",
    adapter: DEFAULT_ADAPTER_REVISION,
    package: {name: "pi-goal-x", version: "0.31.2"},
    ...overrides,
  };
}

test("validates the Gate A identity handshake", () => {
  const result = validateHandshake(validHandshake(), DEFAULT_ADAPTER_REVISION);
  assert.equal(result.ok, true);
  assert.equal(result.identity.piSession, "pi-session-fixture");
  assert.equal(result.identity.package.version, "0.31.2");
  assert.equal(result.identity.capabilities.ordinaryPrompt, true);
  assert.equal(result.identity.capabilities.structuredDialogs, false);
  assert.equal(validateHandshake(validHandshake({adapter: "other"}), DEFAULT_ADAPTER_REVISION).code, "web_first_adapter_revision_mismatch");
  assert.equal(validateHandshake(validHandshake({sessionGeneration: 0}), DEFAULT_ADAPTER_REVISION).code, "web_first_adapter_invalid_generation");
  assert.equal(validateHandshake(validHandshake(), DEFAULT_ADAPTER_REVISION, {packageVersion: "0.30.0"}).code, "web_first_adapter_package_version_mismatch");
  assert.equal(validateHandshake(validHandshake({incompatibleExtensions: ["user-background-extension"]}), DEFAULT_ADAPTER_REVISION).code, "web_first_adapter_incompatible_extension");
});

test("uses private IPC and fails closed after disconnect", async () => {
  const root = await fsMkdtemp();
  const socketPath = path.join(root, "adapter.sock");
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write(`${JSON.stringify(validHandshake())}\n`);
    socket.on("data", (chunk) => {
      for (const line of String(chunk).trim().split("\n")) {
        const request = JSON.parse(line);
        socket.write(`${JSON.stringify({type: "response", id: request.id, success: true, result: {accepted: true, requestId: request.id}})}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const adapter = createPiWebFirstAdapter({socketPath, timeoutMs: 500});
  try {
    const identity = await adapter.connect();
    assert.equal(identity.piSession, "pi-session-fixture");
    assert.equal((await adapter.request("prompt", {message: "hello"})).accepted, true);
    adapter.disconnect();
    await assert.rejects(() => adapter.request("prompt", {message: "must not fall back"}), /web_first_adapter_unavailable/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fsRm(root);
  }
});

test("does not accept an unsupported widget or stale identity", () => {
  assert.equal(validateHandshake(validHandshake({protocol: "wrong"}), DEFAULT_ADAPTER_REVISION).code, "web_first_adapter_protocol_mismatch");
  assert.equal(validateHandshake(validHandshake({package: {name: "pi-goal-x"}}), DEFAULT_ADAPTER_REVISION).code, "web_first_adapter_package_version_missing");
});

async function fsMkdtemp() {
  const fs = require("node:fs/promises");
  return fs.mkdtemp(path.join(os.tmpdir(), "mapache-gate-a-adapter-"));
}

async function fsRm(target) {
  const fs = require("node:fs/promises");
  await fs.rm(target, {recursive: true, force: true});
}
