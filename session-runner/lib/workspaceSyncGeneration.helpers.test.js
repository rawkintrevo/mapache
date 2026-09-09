"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {generationMatchOptions, isStorageGenerationConflict} = require("./workspaceSyncGeneration.helpers");

test("builds create and overwrite generation preconditions", () => {
  assert.deepEqual(generationMatchOptions(), {preconditionOpts: {ifGenerationMatch: 0}});
  assert.deepEqual(generationMatchOptions("42"), {preconditionOpts: {ifGenerationMatch: "42"}});
});

test("recognizes Cloud Storage generation conflicts", () => {
  assert.equal(isStorageGenerationConflict({code: 412}), true);
  assert.equal(isStorageGenerationConflict({code: "412"}), true);
  assert.equal(isStorageGenerationConflict({code: 409}), false);
});
