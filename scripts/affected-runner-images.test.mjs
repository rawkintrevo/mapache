import test from "node:test";
import assert from "node:assert/strict";
import {affectedRunnerVariants, imageVariantForFile} from "./affected-runner-images.mjs";

test("maps variant-specific Dockerfiles and Cloud Build files", () => {
  assert.equal(imageVariantForFile("session-runner/Dockerfile.codex-web"), "codex-web");
  assert.equal(imageVariantForFile("session-runner/cloudbuild.pi-basic.yaml"), "pi-basic");
  assert.equal(imageVariantForFile("session-runner/Dockerfile"), "default");
});

test("shared runner changes include standard variants but skip N64", () => {
  assert.deepEqual(affectedRunnerVariants(["session-runner/lib/workspace.js"]), [
    "default", "pi-basic", "pi-web", "pi-chrome", "codex-basic", "codex-web", "codex-chrome",
  ]);
});

test("N64-specific changes select only N64 when no shared file changed", () => {
  assert.deepEqual(affectedRunnerVariants(["session-runner/seeded-skills/mapache-n64-build/SKILL.md"]), ["pi-n64"]);
});

test("explicit variants can opt into N64", () => {
  assert.deepEqual(affectedRunnerVariants([], {variants: ["pi-n64"]}), ["pi-n64"]);
});
