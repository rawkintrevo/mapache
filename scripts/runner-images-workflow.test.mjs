import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const workflow = await readFile(new URL("../.github/workflows/runner-images.yml", import.meta.url), "utf8");
const cloudbuild = await readFile(new URL("../session-runner/cloudbuild.gcp-runner.yaml", import.meta.url), "utf8");
const dockerfile = await readFile(new URL("../session-runner/Dockerfile.gcp-runner", import.meta.url), "utf8");

test("runner image builds avoid log streaming and wait for Cloud Build status", () => {
  assert.match(workflow, /gcloud builds submit session-runner \\\n+\s+--async/);
  assert.match(workflow, /build_status=\$\(gcloud builds describe "\$build_id"/);
  assert.match(workflow, /PENDING\|QUEUED\|WORKING/);
  assert.match(workflow, /FAILURE\|INTERNAL_ERROR\|TIMEOUT\|CANCELLED\|EXPIRED\|STATUS_UNKNOWN/);
});

test("runner image digest lookup happens only after a successful build", () => {
  const successIndex = workflow.indexOf("SUCCESS)");
  const digestIndex = workflow.indexOf("digest=$(gcloud artifacts docker images describe");

  assert.notEqual(successIndex, -1);
  assert.ok(digestIndex > successIndex);
  assert.match(workflow, /Cloud Build: \$build_url/);
  assert.match(workflow, /digest=\$digest source=\$GITHUB_SHA build=\$build_url/);
});

test("runner image builds resolve and verify the pi-web-ui cache before packaging", () => {
  assert.match(cloudbuild, /buildInputs\.mjs[\s\S]+--key-output pi-web-ui-cache-key/);
  assert.match(cloudbuild, /gcloud storage cp "\$\$\{cache_uri\}" pi-web-ui-cache\.tar\.gz/);
  assert.match(dockerfile, /--cache-archive \/app\/pi-web-ui-cache\.tar\.gz/);
  assert.match(cloudbuild, /artifactCache\.mjs pack/);
  assert.match(cloudbuild, /--if-generation-match=0/);
});

test("pull-request runner builds use the fast upstream test path while releases stay full", () => {
	assert.match(dockerfile, /ARG MAPACHE_SKIP_UPSTREAM_TESTS=1/);
	assert.match(dockerfile, /FROM mapache-base AS pi-web-ui-builder\nARG MAPACHE_BUILD_RESOLUTION_KEY/);
	assert.match(dockerfile, /MAPACHE_SKIP_UPSTREAM_TESTS.*--skip-tests/s);
	assert.match(cloudbuild, /_SKIP_UPSTREAM_TESTS: ["']1["']/);
	assert.match(cloudbuild, /MAPACHE_SKIP_UPSTREAM_TESTS=\$\{_SKIP_UPSTREAM_TESTS\}/);
	assert.match(workflow, /skip_upstream_tests=1/);
	assert.match(workflow, /skip_upstream_tests=0/);
	assert.match(workflow, /_SKIP_UPSTREAM_TESTS=\$skip_upstream_tests/);
});

test("runner image publication is gated by the pi-web-ui page and bundle smoke test", () => {
  const smokeIndex = cloudbuild.indexOf("id: smoke-test-pi-web-ui");
  const imageIndex = cloudbuild.indexOf("images:");
  assert.ok(smokeIndex >= 0);
  assert.ok(imageIndex > smokeIndex);
  assert.match(cloudbuild, /pi-web-ui-smoke\.js/);
  assert.match(cloudbuild, /MAPACHE_AGENT_UI_VERSION=pi-web-ui-v1/);
  assert.match(cloudbuild, /MAPACHE_STARTUP_SMOKE=1/);
});
