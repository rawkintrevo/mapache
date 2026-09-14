#!/usr/bin/env node

import {appendFileSync} from "node:fs";
import {createInterface} from "node:readline";

const TOOLS = [
  {
    name: "echo",
    description: "Returns the supplied message.",
    inputSchema: {type: "object", properties: {message: {type: "string"}}, required: ["message"]},
  },
];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({jsonrpc: "2.0", id, result})}\n`);
}

const rl = createInterface({input: process.stdin, crlfDelay: Infinity});
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    const marker = String(process.env.MCP_FIXTURE_INSTANCE_FILE || "").trim();
    if (marker) appendFileSync(marker, `${process.pid}\n`, "utf8");
    reply(message.id, {
      protocolVersion: "2025-03-26",
      capabilities: {tools: {}},
      serverInfo: {name: "managed-mcp-single-fixture", version: "1.0.0"},
    });
    return;
  }
  if (message.method === "tools/list") {
    reply(message.id, {tools: TOOLS});
    return;
  }
  if (message.method === "tools/call") {
    const value = message.params?.arguments?.message || "";
    reply(message.id, {content: [{type: "text", text: value}]});
    return;
  }
  if (message.method === "shutdown") reply(message.id, null);
});

process.stdin.resume();
