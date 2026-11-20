import test from "node:test";
import assert from "node:assert/strict";
import {affectedRunnerVariants, imageVariantForFile} from "./affected-runner-images.mjs";

test("maps only the supported Dockerfile and Cloud Build file", () => {
  assert.equal(imageVariantForFile("session-runner/Dockerfile.gcp-runner"), "gcp-runner");
  assert.equal(imageVariantForFile("session-runner/cloudbuild.gcp-runner.yaml"), "gcp-runner");
  assert.equal(imageVariantForFile("session-runner/Dockerfile.codex-web"), null);
  assert.equal(imageVariantForFile("session-runner/Dockerfile"), null);
});

test("shared runner changes select gcp-runner", () => {
  assert.deepEqual(affectedRunnerVariants(["session-runner/lib/workspace.js"]), ["gcp-runner"]);
});

test("shared runner changes select the canonical build", () => {
  assert.deepEqual(affectedRunnerVariants(["session-runner/lib/terminal.js"]), ["gcp-runner"]);
});

test("explicit retired variants are ignored", () => {
  assert.deepEqual(affectedRunnerVariants([], {variants: ["pi-chrome", "pi-n64", "codex-web"]}), []);
});
