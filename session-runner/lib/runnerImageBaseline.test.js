const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const runnerRoot = path.resolve(__dirname, "..");
const dockerfiles = [
  "Dockerfile.gcp-runner",
  "Dockerfile.remote-vm-runner",
];

for (const dockerfile of dockerfiles) {
  test(`${dockerfile} provides and validates Python 3 command aliases`, () => {
    const source = fs.readFileSync(path.join(runnerRoot, dockerfile), "utf8");
    assert.match(source, /apt-get install[^\n]*\bpython3\b/);
    assert.match(source, /&& ln -s \/usr\/bin\/python3 \/usr\/local\/bin\/python/);
    assert.match(source, /&& python --version \\/);
    assert.match(source, /&& python3 --version \\/);
  });
}

test("the supported gcp-runner image has one upstream agent entrypoint", () => {
  const source = fs.readFileSync(path.join(runnerRoot, "Dockerfile.gcp-runner"), "utf8");
  assert.match(source, /pi-mcp-adapter@2\.32\.1/);
  assert.match(source, /RUN node \/app\/lib\/patchPiMcpAdapter\.js/);
  assert.match(source, /ENV PI_WEB_MCP_ADAPTER_PATH=\/root\/\.pi\/agent\/npm\/node_modules\/pi-mcp-adapter\/index\.ts/);
  assert.doesNotMatch(source, /pi-goal-x|GOAL_RPC|patchPiGoalX|PI_GOAL_X/);
});

test("the remote VM image has an independent upstream build and no seeded skills", () => {
  const source = fs.readFileSync(path.join(runnerRoot, "Dockerfile.remote-vm-runner"), "utf8");
  assert.match(source, /manifest\.remote-vm\.json/);
  assert.match(source, /ENV MAPACHE_RUNTIME_PROVIDER=remote-libvirt/);
  assert.match(source, /ENV RUNNER_CAPABILITIES=\{"terminal":true,"preview":false,"previewQa":false,"functions":false,"chrome":true\}/);
  assert.doesNotMatch(source, /COPY seeded-skills/);
  assert.doesNotMatch(source, /managed-keel/);
});
