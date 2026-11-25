"use strict";

const assert = require("node:assert/strict");
const {readFile} = require("node:fs/promises");
const {execFileSync} = require("node:child_process");
const {createConfig} = require("/app/lib/config");

async function main() {
  const config = createConfig();
  assert.equal(config.workspaceId, "vm-import-proof-605");
  assert.equal(config.startupSmoke, false);
  const url = "http://127.0.0.1:8080/runner/health";
  const denied = await fetch(url, {signal: AbortSignal.timeout(3000)});
  assert.equal(denied.status, 404);
  const response = await fetch(url, {
    headers: {"x-shutdown-token": process.env.SESSION_SHUTDOWN_TOKEN},
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.sessionId, "vm-import-proof-605-g1");
  assert.equal(health.agentRuntime.ready, true);
  assert.equal(config.workspaceDir, "/var/lib/mapache/workspace/workspace");
  assert.equal(config.piSessionDir, "/var/lib/mapache/workspace/agent/sessions");
  const executable = execFileSync(config.workspaceDir + "/bin/disposable-proof", {encoding: "utf8"});
  assert.equal(executable, "retained-import-ok");
  const history = await readFile(config.piSessionDir + "/history.jsonl", "utf8");
  assert.equal(history, '{"type":"session","id":"synthetic"}\n');
  const receipt = JSON.parse(await readFile("/var/lib/mapache/workspace/.mapache-import-stage/disk-import-receipt.json", "utf8"));
  assert.equal(receipt.selectedEntries, 2);
  console.log(JSON.stringify({agentReady: true, healthStatus: 200, anonymousHealthStatus: 404,
    receiptSha256: receipt.sourcePlanSha256, restoredExecutableRan: true, restoredHistoryMatched: true}));
}

main().catch(() => {
  console.error("imported_runner_not_verified");
  process.exitCode = 1;
});
