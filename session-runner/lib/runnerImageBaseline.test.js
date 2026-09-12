const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const runnerRoot = path.resolve(__dirname, "..");
const dockerfiles = [
  "Dockerfile.pi-chrome",
];

for (const dockerfile of dockerfiles) {
  test(`${dockerfile} provides and validates Python 3`, () => {
    const source = fs.readFileSync(path.join(runnerRoot, dockerfile), "utf8");
    assert.match(source, /apt-get install[^\n]*\bpython3\b/);
    assert.match(source, /&& python3 --version \\/);
  });
}

test("the supported pi-chrome image has one upstream agent entrypoint", () => {
  const source = fs.readFileSync(path.join(runnerRoot, "Dockerfile.pi-chrome"), "utf8");
  assert.match(source, /pi-mcp-adapter@2\.32\.1/);
  assert.match(source, /RUN node \/app\/lib\/patchPiMcpAdapter\.js/);
  assert.match(source, /ENV PI_WEB_MCP_ADAPTER_PATH=\/root\/\.pi\/agent\/npm\/node_modules\/pi-mcp-adapter\/index\.ts/);
  assert.doesNotMatch(source, /pi-goal-x|GOAL_RPC|patchPiGoalX|PI_GOAL_X/);
});
