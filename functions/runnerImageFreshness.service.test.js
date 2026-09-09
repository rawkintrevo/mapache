"use strict";

const assert = require("node:assert/strict");
const {
  createRunnerImageFreshnessService,
  getSessionImageFreshness,
  normalizeDigest,
  parseRunnerImageReference,
} = require("./runnerImageFreshness.service");

const image = "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-basic";
const currentDigest = "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const staleDigest = "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

assert.deepStrictEqual(parseRunnerImageReference(image), {
  host: "us-central1",
  image,
  imagePackage: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner",
  location: "us-central1",
  project: "pi-agents-cloud",
  repository: "pi-agents",
  tag: "pi-basic",
});
assert.strictEqual(parseRunnerImageReference("custom/image:tag"), null);
assert.strictEqual(normalizeDigest(currentDigest), "@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
assert.strictEqual(getSessionImageFreshness({status: "provisioning", runnerImageDigest: currentDigest}, currentDigest), "unknown");
assert.strictEqual(getSessionImageFreshness({status: "running", runnerImageDigest: currentDigest}, currentDigest), "latest");
assert.strictEqual(getSessionImageFreshness({status: "running", runnerImageDigest: currentDigest}, staleDigest), "stale");
assert.strictEqual(getSessionImageFreshness({status: "running"}, currentDigest), "unknown");

(async () => {
  let calls = 0;
  const service = createRunnerImageFreshnessService({
    auth: {
      getClient: async () => ({
        request: async () => {
          calls += 1;
          return {data: {dockerImages: [{
            package: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner",
            tags: ["pi-basic"],
            uri: currentDigest,
          }]}};
        },
      }),
    },
  });
  assert.strictEqual(await service.getCurrentRunnerImageDigest(image), currentDigest);
  assert.strictEqual(await service.getCurrentRunnerImageDigest(image), currentDigest);
  assert.strictEqual(calls, 1);
  console.log("runner image freshness service tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
