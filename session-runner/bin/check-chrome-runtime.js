#!/usr/bin/env node

"use strict";

const fs = require("fs");
const {spawnSync} = require("child_process");

const requiredCommands = [
  "chromium",
  "openbox",
  "tint2",
  "x11vnc",
  "Xvfb",
  "websockify",
];
const requiredPaths = [
  "/etc/chromium/policies/managed/mapache.json",
  "/usr/share/novnc/vnc.html",
  "/usr/share/novnc/app/ui.js",
];

const missingCommands = requiredCommands.filter((command) => {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], {stdio: "ignore"});
  return result.status !== 0;
});
const missingPaths = requiredPaths.filter((filePath) => !fs.existsSync(filePath));
const policyPath = "/etc/chromium/policies/managed/mapache.json";
const policies = missingPaths.includes(policyPath) ? {} : JSON.parse(fs.readFileSync(policyPath, "utf8"));
const invalidPolicy = policies.CommandLineFlagSecurityWarningsEnabled !== false;

if (missingCommands.length || missingPaths.length || invalidPolicy) {
  if (missingCommands.length) console.error(`missing Chrome runtime commands: ${missingCommands.join(", ")}`);
  if (missingPaths.length) console.error(`missing Chrome runtime assets: ${missingPaths.join(", ")}`);
  if (invalidPolicy) console.error("Chrome command-line security warning policy is not disabled");
  process.exitCode = 1;
} else {
  console.log("Chrome runtime dependencies and noVNC assets are present");
}
