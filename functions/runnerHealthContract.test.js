"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// Regression guard: this reserved Cloud Run path has repeatedly been restored
// by well-intentioned endpoint renames. Neither aliases nor fallbacks are valid.
test("production runner and Functions code never serves or calls reserved healthz paths", () => {
  const violations = [];
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      if (["node_modules", ".git", "upstream", "__tests__"].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (/\.(?:js|mjs)$/.test(entry.name) && !/\.test\.(?:js|mjs)$/.test(entry.name)) {
        if (fs.readFileSync(file, "utf8").includes("/healthz")) violations.push(file);
      }
    }
  }
  scan(__dirname);
  scan(path.join(__dirname, "../session-runner"));
  assert.deepEqual(violations, [], "Use /runner/health; /healthz and trailing-slash aliases are forbidden (AGENTS.md).");
});
