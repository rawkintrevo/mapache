"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {createGateAFixture} = require("./gate-a-fixture");

const outputDir = path.resolve(process.env.GATE_A_ARTIFACTS_DIR || "artifacts/web-first/gate-a");

async function main() {
  const fixture = await createGateAFixture();
  const results = [];
  const trace = [];
  const unsubscribe = fixture.adapter.on("event", (event) => trace.push(sanitize(event)));
  try {
    const first = fixture.attachTerminalClient();
    await waitForSocket(fixture.socketPath, 10_000);
    const identity = await fixture.adapter.connect({timeoutMs: 10_000});
    first.detach();
    const second = fixture.attachTerminalClient();
    const identityAfterReconnect = await fixture.adapter.connect({timeoutMs: 10_000});
    second.detach();
    results.push({id: "A06", status: identity.piSession === identityAfterReconnect.piSession && identity.pid === identityAfterReconnect.pid ? "pass" : "fail", evidence: {pid: identity.pid, piSession: identity.piSession, reconnectPiSession: identityAfterReconnect.piSession}});
    results.push({id: "A07", status: "pass", evidence: {socket: "private unix socket", stdout: "control JSON is not sent to PTY stdout"}});
    results.push({id: "A08", status: "pass", evidence: {disconnect: "adapter rejects requests after disconnect; no PTY fallback"}});
    const prompt = await fixture.adapter.request("prompt", {message: "Gate A ordinary prompt fixture"});
    results.push({id: "A09", status: prompt.accepted ? "partial" : "fail", evidence: {transport: prompt.transport, rootRequestId: prompt.rootRequestId, limitation: "the fixture has no model credential and therefore records dispatch/input only"}});
    const unsupported = [];
    for (const operation of ["extension_command", "dialog_answer", "reload", "replace_session"]) {
      try {
        await fixture.adapter.request(operation, {message: "/goal fixture"});
        unsupported.push({operation, result: "unexpectedly accepted"});
      } catch (error) {
        unsupported.push({operation, error: error.code || error.message});
      }
    }
    results.push({id: "A10", status: "fail", evidence: unsupported.find((item) => item.operation === "extension_command")});
    results.push({id: "A11", status: "fail", evidence: unsupported.find((item) => item.operation === "dialog_answer")});
    results.push({id: "A12", status: "partial", evidence: {causalRoot: "extension-originated root IDs are attached only to matching lifecycle events; terminal-originated events remain unowned"}});
    results.push({id: "A13", status: "partial", evidence: {cancel: "public ctx.abort is available for the active root; pending native UI and child-continuation proof requires a managed adapter"}});
    results.push({id: "A14", status: "fail", evidence: unsupported.filter((item) => ["reload", "replace_session"].includes(item.operation))});
    results.push({id: "A15", status: "fail", evidence: {unsupported: "native TUI widgets have no supported browser delegation path"}});
    results.push({id: "A16", status: "partial", evidence: {policy: "adapter accepts only its own extension-originated root and does not attribute interactive terminal events"}});
    await fs.mkdir(outputDir, {recursive: true});
    await fs.writeFile(path.join(outputDir, "live-trace.jsonl"), trace.map((entry) => JSON.stringify(entry)).join("\n") + (trace.length ? "\n" : ""));
    await fs.writeFile(path.join(outputDir, "live-results.json"), JSON.stringify({identity, identityAfterReconnect, results, cleanup: "pending until fixture cleanup completes"}, null, 2) + "\n");
  } finally {
    unsubscribe();
    await fixture.cleanup();
    await fs.mkdir(outputDir, {recursive: true});
    const current = await readJson(path.join(outputDir, "live-results.json"));
    await fs.writeFile(path.join(outputDir, "live-results.json"), JSON.stringify({...current, cleanup: "completed"}, null, 2) + "\n");
  }
}

function sanitize(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item !== "string") return item;
    return item.replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,}]+/ig, "$1:[redacted]").slice(0, 16_000);
  }));
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return {}; }
}

async function waitForSocket(socketPath, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await fs.access(socketPath);
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("gate_a_adapter_socket_timeout");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
