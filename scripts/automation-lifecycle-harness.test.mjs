import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import {parseArgs, PROJECT_ID, runCommand} from "./automation-lifecycle-harness.mjs";

test("lifecycle harness requires the explicit production project", () => {
  assert.equal(parseArgs(["run", "--project", PROJECT_ID]).mode, "deterministic");
  assert.throws(() => parseArgs(["run", "--project", "wrong"]), /project must be/);
  assert.throws(() => parseArgs(["run", "--project", PROJECT_ID, "--mode", "live"]), /runner-url/);
});

test("deterministic lifecycle harness proves cleanup and prompt fencing", async () => {
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), "mapache-automation-lifecycle-"));
  try {
    const result = await runCommand(["run", "--project", PROJECT_ID, "--artifact-dir", artifactDir]);
    assert.equal(result.ok, true);
    assert.equal(result.evidence.activeRuns.length, 0);
    assert.ok(result.checks.some((check) => check.name === "one prompt dispatch" && check.ok));
  } finally {
    await rm(artifactDir, {recursive: true, force: true});
  }
});
