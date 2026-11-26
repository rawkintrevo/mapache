"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {MAX_LABEL_VALUE_LENGTH, normalizeComputeEngineLabelValue} = require("./computeEngineLabels.helpers");

test("normalizes Firebase identifiers into valid Compute Engine label values", () => {
  const value = normalizeComputeEngineLabelValue("CWgOpYpwJTY4Cd5mwPEo");
  assert.equal(value, "cwgopypwjty4cd5mwpeo");
  assert.match(value, /^[a-z][a-z0-9_-]*$/);
  assert.ok(value.length <= MAX_LABEL_VALUE_LENGTH);
});

test("bounds long and non-letter values without losing deterministic identity", () => {
  const input = "9".repeat(100);
  const first = normalizeComputeEngineLabelValue(input);
  const second = normalizeComputeEngineLabelValue(input);
  assert.equal(first, second);
  assert.match(first, /^m-9+-[a-f0-9]{12}$/);
  assert.ok(first.length <= MAX_LABEL_VALUE_LENGTH);
});
