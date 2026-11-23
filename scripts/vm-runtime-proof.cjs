"use strict";

// Run inside the synthetic VM's actual runner container. Never prints tokens.
const assert = require("node:assert/strict");
const {execFileSync} = require("node:child_process");
const {createConfig} = require("/app/lib/config");
const config = createConfig();
assert.equal(config.workspaceId, "vm-proof-605");
assert.equal(config.startupSmoke, false);

async function main() {
  const origin = "http://127.0.0.1:8080";
  const denied = await fetch(`${origin}/runner/health`);
  assert.equal(denied.status, 404);
  const health = await fetch(`${origin}/runner/health`, {
    headers: {"x-shutdown-token": process.env.SESSION_SHUTDOWN_TOKEN}, signal: AbortSignal.timeout(15000),
  });
  assert.equal(health.status, 200);
  const data = await health.json();
  assert.equal(data.agentRuntime.ready, true);
  assert.equal(data.sessionId, config.sessionId);
  let metadataBlocked = false;
  try {
    const result = await fetch("http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token", {
      headers: {"Metadata-Flavor": "Google"}, signal: AbortSignal.timeout(3000),
    });
    metadataBlocked = !result.ok;
  } catch { metadataBlocked = true; }
  assert.equal(metadataBlocked, true);
  assert.equal(config.workspaceDir, "/var/lib/mapache/workspace/workspace");
  assert.equal(config.homeDir, "/var/lib/mapache/workspace/home");
  const {createWorkspaceProcessEnvironment} = require("/app/lib/runnerEnvironment");
  const env = createWorkspaceProcessEnvironment(config);
  const child = JSON.parse(execFileSync(process.execPath, ["-e", "console.log(JSON.stringify({home:process.env.HOME,cwd:process.cwd()}))"], {
    cwd: config.workspaceDir, env, encoding: "utf8",
  }));
  assert.equal(child.home, config.homeDir);
  assert.equal(child.cwd, config.workspaceDir);
  console.log(JSON.stringify({ok: true, startupSmoke: false, healthStatus: health.status,
    agentReady: true, metadataBlocked, retainedChildHome: true, retainedWorkspace: true, sessionId: config.sessionId}));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
