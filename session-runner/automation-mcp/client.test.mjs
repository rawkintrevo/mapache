import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {createAutomationAgentClient} from "./client.mjs";

test("Unix transport preserves revision bodies on DELETE requests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "automation-mcp-"));
  const socketPath = path.join(root, "broker.sock");
  const received = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({method: request.method, body: Buffer.concat(chunks).toString("utf8")});
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ok: true}));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const client = createAutomationAgentClient({socketPath});
    const result = await client.call("/api/agent/automations/fixture", {
      method: "DELETE", body: {expectedRevision: 3}, retry: false,
    });
    assert.deepEqual(result, {ok: true});
    assert.deepEqual(received, [{method: "DELETE", body: JSON.stringify({expectedRevision: 3})}]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, {recursive: true, force: true});
  }
});
