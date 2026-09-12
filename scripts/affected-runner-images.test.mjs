import test from "node:test";
import assert from "node:assert/strict";
import {affectedRunnerVariants, imageVariantForFile} from "./affected-runner-images.mjs";

test("maps only the supported Dockerfile and Cloud Build file", () => {
  assert.equal(imageVariantForFile("session-runner/Dockerfile.pi-chrome"), "pi-chrome");
  assert.equal(imageVariantForFile("session-runner/cloudbuild.pi-chrome.yaml"), "pi-chrome");
  assert.equal(imageVariantForFile("session-runner/Dockerfile.codex-web"), null);
  assert.equal(imageVariantForFile("session-runner/Dockerfile"), null);
});

test("shared runner changes select pi-chrome", () => {
  assert.deepEqual(affectedRunnerVariants(["session-runner/lib/workspace.js"]), ["pi-chrome"]);
});

test("retired runner changes do not create a retired build", () => {
  assert.deepEqual(affectedRunnerVariants(["session-runner/lib/terminal.js"]), ["pi-chrome"]);
});

test("explicit retired variants are ignored", () => {
  assert.deepEqual(affectedRunnerVariants([], {variants: ["pi-n64", "codex-web"]}), []);
});
