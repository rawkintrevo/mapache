import assert from "node:assert/strict";
import {once} from "node:events";
import {spawn} from "node:child_process";
import {test} from "node:test";
import {fileURLToPath} from "node:url";

const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));

function startServer() {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const resolver = pending.get(message.id);
      if (resolver) {
        pending.delete(message.id);
        resolver(message);
      }
    }
  });
  return {
    child,
    request(method, params = {}) {
      const id = pending.size + 1;
      child.stdin.write(JSON.stringify({jsonrpc: "2.0", id, method, params}) + "\n");
      return new Promise((resolve) => pending.set(id, resolve));
    },
    async close() {
      child.kill("SIGTERM");
      await once(child, "exit");
    },
  };
}

async function initializedServer() {
  const server = startServer();
  const initialize = await server.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: {name: "mapache-test", version: "0.1.0"},
  });
  assert.equal(initialize.error, undefined);
  server.child.stdin.write(JSON.stringify({jsonrpc: "2.0", method: "notifications/initialized", params: {}}) + "\n");
  return server;
}

test("initialize succeeds and tools/list exposes only health", async () => {
  const server = await initializedServer();
  try {
    const result = await server.request("tools/list");
    assert.deepEqual(result.result.tools.map((tool) => tool.name), ["google_workspace_health"]);
  } finally {
    await server.close();
  }
});

test("tools/call returns the deterministic health payload", async () => {
  const server = await initializedServer();
  try {
    const result = await server.request("tools/call", {name: "google_workspace_health", arguments: {}});
    assert.equal(result.error, undefined);
    assert.deepEqual(result.result.structuredContent, {ok: true});
    assert.deepEqual(JSON.parse(result.result.content[0].text), {ok: true});
  } finally {
    await server.close();
  }
});

test("unknown tools return an MCP error", async () => {
  const server = await initializedServer();
  try {
    const result = await server.request("tools/call", {name: "not_a_real_tool", arguments: {}});
    assert.equal(result.result, undefined);
    assert.equal(result.error.code, -32602);
  } finally {
    await server.close();
  }
});
