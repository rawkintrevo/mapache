"use strict";

const assert = require("node:assert/strict");
const {execFileSync} = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Opt in with a locally available pi-chrome image. Uses its inherited Node
// entrypoint and the current Dockerfile CMD, without production credentials.
test("container SIGTERM reaches runner cleanup before PID 1 exits", {
  skip: !process.env.MAPACHE_SIGNAL_TEST_IMAGE,
  timeout: 30_000,
}, async () => {
  const docker = (...args) => execFileSync("docker", args, {encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"]}).trim();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mapache-signals-"));
  // Docker may run through a confined client or a different daemon user.
  fs.chmodSync(directory, 0o755);
  let container;
  try {
    fs.copyFileSync(path.join(__dirname, "runnerSignals.js"), path.join(directory, "runnerSignals.js"));
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({scripts: {start: "node server.js"}}));
    fs.writeFileSync(path.join(directory, "server.js"), `
      require('./runnerSignals').registerRunnerSignals({budgetMs: 8000,
        runnerLifecycle: {shutdownWithBudget: async ({reason}) => {
          if (reason !== 'SIGTERM') throw new Error('unexpected signal');
          await new Promise(resolve => setTimeout(resolve, 100));
          console.log('CLEANUP_COMPLETED');
        }},
      });
      console.log('READY');
      setInterval(() => {}, 1000);
    `);
    const dockerfile = fs.readFileSync(path.join(__dirname, "../Dockerfile.pi-chrome"), "utf8");
    const command = JSON.parse(dockerfile.match(/^CMD (.+)$/m)[1]);
    container = docker("create", "--network=none", "--volume", `${directory}:/signal-test:ro`, "--workdir=/signal-test", process.env.MAPACHE_SIGNAL_TEST_IMAGE, ...command);
    docker("start", container);
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (docker("logs", container).includes("READY")) { ready = true; break; }
      assert.equal(docker("inspect", "--format={{.State.Running}}", container), "true", "fixture exited before readiness");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, "fixture must start before sending SIGTERM");
    docker("stop", "--time=3", container);
    const logs = docker("logs", container);
    assert.match(logs, /signal shutdown started/);
    assert.match(logs, /CLEANUP_COMPLETED/);
    assert.match(logs, /signal shutdown completed/);
    assert.equal(docker("inspect", "--format={{.State.ExitCode}}", container), "0");
  } finally {
    if (container) docker("rm", "--force", container);
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
