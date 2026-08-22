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
