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
  assert.equal(immutableRunnerTag("gcp-runner", SHA), `gcp-runner-${SHA}`);
  assert.notEqual(immutableRunnerTag("gcp-runner", SHA), immutableRunnerTag("gcp-runner", `${SHA.slice(0, 39)}8`));
});

test("pull request tags are unique but bounded for logs", () => {
  assert.equal(pullRequestRunnerTag("gcp-runner", 246, SHA), "gcp-runner-pr-246-0123456789ab");
});

test("invalid revisions fail closed", () => {
  assert.throws(() => normalizeSha("not-a-sha"), /40-character commit SHA/);
});

test("compatibility tags use the supported runner key", () => {
  assert.equal(compatibilityRunnerTag("gcp-runner"), "gcp-runner");
  assert.equal(compatibilityRunnerTag("remote-vm-runner"), "remote-vm-runner");
});

test("retired variants fail closed", () => {
  assert.throws(() => immutableRunnerTag("pi-chrome", SHA), /unsupported runner image variant/);
  assert.throws(() => immutableRunnerTag("codex-web", SHA), /unsupported runner image variant/);
  assert.throws(() => compatibilityRunnerTag("default"), /unsupported runner image variant/);
});
