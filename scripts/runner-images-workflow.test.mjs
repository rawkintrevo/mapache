import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const workflow = await readFile(new URL("../.github/workflows/runner-images.yml", import.meta.url), "utf8");

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
