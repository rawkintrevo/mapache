"use strict";

const assert = require("assert");
const {
  resolveRunnerImage,
  runnerImageCapabilities,
} = require("./runnerImages.helpers");

function code(fn) {
  try {
    fn();
  } catch (error) {
    return error.code || error.message;
  }
  return "";
}

const webImage = resolveRunnerImage({imageKey: "pi-web"});
assert.strictEqual(webImage.key, "pi-web");
assert.strictEqual(webImage.image, "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-web");
assert.strictEqual(webImage.terminalKind, "pi");
assert.deepStrictEqual(webImage.capabilities, {
  terminal: true,
  preview: true,
  previewQa: true,
  functions: true,
  n64: false,
});
assert.strictEqual(webImage.canProvision, true);

const codexWebImage = resolveRunnerImage({imageKey: "codex-web"});
assert.strictEqual(codexWebImage.key, "codex-web");
assert.strictEqual(codexWebImage.image, "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:codex-web");
assert.strictEqual(codexWebImage.terminalKind, "codex");
assert.deepStrictEqual(codexWebImage.capabilities, {
  terminal: true,
  preview: true,
  previewQa: true,
  functions: true,
  n64: false,
});
assert.strictEqual(codexWebImage.canProvision, true);

const shellImage = resolveRunnerImage({imageKey: "default"});
assert.strictEqual(shellImage.key, "default");
assert.strictEqual(shellImage.terminalKind, "shell");

const legacyImage = resolveRunnerImage({
  image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-basic",
});
assert.strictEqual(legacyImage.key, "pi-basic");
assert.strictEqual(legacyImage.canProvision, true);

assert.strictEqual(code(() => resolveRunnerImage({imageKey: "unknown"})), "invalid_runner_image");
assert.strictEqual(
    code(() => resolveRunnerImage({image: "docker.io/attacker/runner:latest"})),
    "invalid_runner_image",
);

const configuredDefault = resolveRunnerImage(
    {},
    "us-central1-docker.pkg.dev/example-project/example-repo/custom-runner@sha256:abc",
);
assert.strictEqual(configuredDefault.key, "configured-default");
assert.strictEqual(configuredDefault.canProvision, true);
assert.deepStrictEqual(runnerImageCapabilities("unknown"), {
  terminal: true,
  preview: false,
  previewQa: false,
  functions: false,
  n64: false,
});

assert.strictEqual(resolveRunnerImage({}, "").canProvision, false);

console.log("runner image helper tests passed");
