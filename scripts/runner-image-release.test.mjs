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
  assert.equal(immutableRunnerTag("pi-chrome", SHA), `pi-chrome-${SHA}`);
  assert.notEqual(immutableRunnerTag("pi-chrome", SHA), immutableRunnerTag("pi-chrome", `${SHA.slice(0, 39)}8`));
});

test("pull request tags are unique but bounded for logs", () => {
  assert.equal(pullRequestRunnerTag("pi-chrome", 246, SHA), "pi-chrome-pr-246-0123456789ab");
});

test("invalid revisions fail closed", () => {
  assert.throws(() => normalizeSha("not-a-sha"), /40-character commit SHA/);
});

test("compatibility tags use the supported runner key", () => {
  assert.equal(compatibilityRunnerTag("pi-chrome"), "pi-chrome");
});

test("retired variants fail closed", () => {
  assert.throws(() => immutableRunnerTag("codex-web", SHA), /unsupported runner image variant/);
  assert.throws(() => compatibilityRunnerTag("default"), /unsupported runner image variant/);
});
