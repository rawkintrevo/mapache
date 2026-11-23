"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {assertCapturedSymlinkTargets} = require("./checkpointSymlinkPlan");
const link = (path, target) => ({kind: "symlink", path, target});
const file = (path) => ({kind: "workspace-file", path});

test("validates captured tool aliases and links into directory aliases", () => {
  assert.doesNotThrow(() => assertCapturedSymlinkTargets([
    file(".local/lib/v1/bin/tool"),
    link(".local/lib/current", "v1"),
    link(".local/bin/tool", "../lib/current/bin/tool"),
    link(".local/bin/alias", "tool"),
  ]));
});

test("rejects missing targets, missing intermediate aliases and cyclic plans", () => {
  for (const entries of [
    [link(".local/bin/tool", "../lib/node_modules/tool/bin.js")],
    [file(".local/lib/v1/bin/tool"), link(".local/bin/tool", "../lib/current/bin/tool")],
    [link("a", "b"), link("b", "a")],
    [file("a"), link("b", "a/child")],
  ]) assert.throws(() => assertCapturedSymlinkTargets(entries), {code: "checkpoint_unsafe_symlink"});
});
