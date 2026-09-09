import test from "node:test";
import assert from "node:assert/strict";
import {
  compatibilityRunnerTag,
  immutableRunnerTag,
  normalizeSha,
  pullRequestRunnerTag,
} from "./runner-image-release.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("immutable tags include the complete source revision", () => {
  assert.equal(immutableRunnerTag("codex-web", SHA), `codex-web-${SHA}`);
  assert.notEqual(immutableRunnerTag("codex-web", SHA), immutableRunnerTag("codex-web", `${SHA.slice(0, 39)}8`));
});

test("pull request tags are unique but bounded for logs", () => {
  assert.equal(pullRequestRunnerTag("pi-basic", 246, SHA), "pi-basic-pr-246-0123456789ab");
});

test("invalid revisions fail closed", () => {
  assert.throws(() => normalizeSha("not-a-sha"), /40-character commit SHA/);
});

test("compatibility tags map the default runner to latest", () => {
  assert.equal(compatibilityRunnerTag("default"), "latest");
  assert.equal(compatibilityRunnerTag("pi-basic"), "pi-basic");
});
