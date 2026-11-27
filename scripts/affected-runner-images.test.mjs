import test from "node:test";
import assert from "node:assert/strict";
import {affectedRunnerVariants, imageVariantForFile} from "./affected-runner-images.mjs";

test("maps only the supported Dockerfile and Cloud Build file", () => {
  assert.equal(imageVariantForFile("session-runner/Dockerfile.gcp-runner"), "gcp-runner");
  assert.equal(imageVariantForFile("session-runner/cloudbuild.gcp-runner.yaml"), "gcp-runner");
  assert.equal(imageVariantForFile("session-runner/Dockerfile.remote-vm-runner"), "remote-vm-runner");
  assert.equal(imageVariantForFile("session-runner/cloudbuild.remote-vm-runner.yaml"), "remote-vm-runner");
  assert.equal(imageVariantForFile("session-runner/Dockerfile.codex-web"), null);
  assert.equal(imageVariantForFile("session-runner/Dockerfile"), null);
});

test("shared runner changes select both independent images", () => {
  assert.deepEqual(affectedRunnerVariants(["session-runner/lib/workspace.js"]), ["gcp-runner", "remote-vm-runner"]);
});

test("GCP-only seeded skills do not select the VM image", () => {
  assert.deepEqual(affectedRunnerVariants(["session-runner/seeded-skills/web.md"]), ["gcp-runner"]);
});

test("explicit retired variants are ignored", () => {
  assert.deepEqual(affectedRunnerVariants([], {variants: ["pi-chrome", "pi-n64", "codex-web"]}), []);
});
