import test from "node:test";
import assert from "node:assert/strict";
import {generatedCatalog, renderedCatalog} from "./generate-runner-catalog.mjs";

test("generated catalog contains every shared harness and image", () => {
  const catalog = generatedCatalog();
  assert.deepEqual(Object.keys(catalog.harnesses), ["pi"]);
  assert.deepEqual(catalog.images.map((image) => image.imageKey), ["pi-chrome"]);
  assert.match(renderedCatalog(), /"harnesses"/);
});
