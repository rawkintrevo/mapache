const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const runnerRoot = path.resolve(__dirname, "..");
const dockerfiles = [
  "Dockerfile",
  "Dockerfile.pi-basic",
  "Dockerfile.pi-web",
  "Dockerfile.pi-n64",
  "Dockerfile.pi-chrome",
  "Dockerfile.codex-basic",
  "Dockerfile.codex-web",
  "Dockerfile.codex-chrome",
];

for (const dockerfile of dockerfiles) {
  test(`${dockerfile} provides and validates Python 3`, () => {
    const source = fs.readFileSync(path.join(runnerRoot, dockerfile), "utf8");

    assert.match(source, /apt-get install[^\n]*\bpython3\b/);
    assert.match(source, /&& python3 --version \\/);
  });
}

for (const dockerfile of ["Dockerfile.pi-basic", "Dockerfile.pi-web", "Dockerfile.pi-chrome"]) {
  test(`${dockerfile} preinstalls the pinned Pi Goals package`, () => {
    const source = fs.readFileSync(path.join(runnerRoot, dockerfile), "utf8");
    assert.match(source, /RUN pi install npm:pi-goal-x@0\.31\.2/);
    assert.match(source, /RUN node \/app\/lib\/patchPiGoalX\.js/);
    assert.match(source, /ENV GOAL_BRIDGE_ENABLED=true/);
    assert.match(source, /ENV GOAL_RPC_ENABLED=true/);
    assert.match(source, /ENV PI_GOAL_X_VERSION=0\.31\.2/);
  });
}

test("Dockerfile.pi-chrome pins the Gate A Pi and adapter revisions", () => {
  const source = fs.readFileSync(path.join(runnerRoot, "Dockerfile.pi-chrome"), "utf8");
  assert.match(source, /ARG PI_VERSION=0\.84\.1/);
  assert.match(source, /@earendil-works\/pi-coding-agent@\$\{PI_VERSION\}/);
  assert.match(source, /pi-mcp-adapter@\$\{PI_MCP_ADAPTER_VERSION\}/);
  assert.match(source, /ARG PI_MCP_ADAPTER_VERSION=2\.32\.1/);
  assert.match(source, /ENV MAPACHE_PI_WEB_FIRST_ADAPTER_REVISION=gate-a-0\.1\.0/);
  assert.match(source, /ENV MAPACHE_WEB_FIRST_ENABLED=false/);
  assert.match(source, /ENV MAPACHE_PI_WEB_FIRST_SOCKET=\/tmp\/mapache-pi-web-first\.sock/);
});
