import test from "node:test";
import assert from "node:assert/strict";
import {generatedCatalog, renderedCatalog} from "./generate-runner-catalog.mjs";

test("generated catalog contains every shared harness and image", () => {
  const catalog = generatedCatalog();
  assert.deepEqual(Object.keys(catalog.harnesses), ["shell", "ssh", "pi", "codex"]);
  assert.ok(catalog.images.some((image) => image.imageKey === "codex-web"));
  assert.match(renderedCatalog(), /"harnesses"/);
});
