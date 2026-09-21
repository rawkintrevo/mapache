import assert from "node:assert/strict";
import test from "node:test";
import {parseArgs, PROJECT_ID, RETENTION_SECONDS} from "./automation-storage-live-harness.mjs";

test("live storage harness requires the explicit production project", () => {
  const args = parseArgs(["run", "--project", PROJECT_ID, "--storage-rate-usd-per-gib-month", "0.02"]);
  assert.equal(args.project, PROJECT_ID);
  assert.equal(args["storage-rate-usd-per-gib-month"], "0.02");
  assert.equal(RETENTION_SECONDS, 604800);
  assert.throws(() => parseArgs(["run", "--project", "wrong-project"]), /project must be/);
});

test("live harness supports keep and rejects unsupported options", () => {
  const args = parseArgs(["--project=pi-agents-cloud", "--keep"]);
  assert.equal(args.keep, true);
  assert.throws(() => parseArgs(["run", "--project", "pi-agents-cloud", "--secret", "nope"]), /unsupported option/);
});
