"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {patchNoVncWebUtil} = require("./noVncWebUtil");

test("patches noVNC settings storage with guarded helpers", () => {
  const source = `
/*
 * Setting handling.
 */
localStorage.setItem(name, value);
value = localStorage.getItem(name);
localStorage.removeItem(name);
`;
  const patched = patchNoVncWebUtil(source);

  assert.match(patched, /function readLocalSetting/);
  assert.match(patched, /writeLocalSetting\(name, value\);/);
  assert.match(patched, /value = readLocalSetting\(name\);/);
  assert.match(patched, /removeLocalSetting\(name\);/);
});

test("rejects an unexpected noVNC source layout", () => {
  assert.throws(() => patchNoVncWebUtil("localStorage.getItem(name);"), /settings marker/);
});
