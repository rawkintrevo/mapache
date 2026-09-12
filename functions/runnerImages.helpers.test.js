"use strict";

const assert = require("assert");
const {
  isSupportedProvisioningSession,
  resolveRunnerImage,
  resolveSessionCapabilities,
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

const image = resolveRunnerImage({imageKey: "pi-chrome"});
assert.strictEqual(image.key, "pi-chrome");
assert.strictEqual(image.image, "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome");
assert.strictEqual(image.harnessId, "pi");
assert.strictEqual(image.terminalKind, "pi");
assert.deepStrictEqual(image.capabilities, {
  terminal: true,
  preview: true,
  previewQa: true,
  functions: true,
  chrome: true,
});
assert.strictEqual(image.canProvision, true);

const refreshedImage = resolveSessionCapabilities({
  imageKey: "pi-chrome",
  capabilities: {terminal: true, preview: false, previewQa: false, functions: false, chrome: false},
});
assert.deepStrictEqual(refreshedImage, image.capabilities);

assert.strictEqual(code(() => resolveRunnerImage({imageKey: "default"})), "invalid_runner_image");
assert.strictEqual(code(() => resolveRunnerImage({imageKey: "codex-web"})), "invalid_runner_image");
assert.strictEqual(
    code(() => resolveRunnerImage({image: "docker.io/attacker/runner:latest"})),
    "invalid_runner_image",
);
assert.deepStrictEqual(runnerImageCapabilities("unknown"), {
  terminal: false,
  preview: false,
  previewQa: false,
  functions: false,
  chrome: false,
});

assert.strictEqual(isSupportedProvisioningSession({
  imageKey: "pi-chrome",
  image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome",
  sessionType: "cloud",
  terminalKind: "pi",
}), true);
assert.strictEqual(isSupportedProvisioningSession({
  imageKey: "codex-web",
  image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:codex-web",
}), false);
assert.strictEqual(isSupportedProvisioningSession({
  imageKey: "pi-chrome",
  image: "docker.io/attacker/runner:latest",
}), false);

console.log("runner image helper tests passed");
