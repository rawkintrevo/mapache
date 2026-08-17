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
  "/usr/share/novnc/vnc.html",
  "/usr/share/novnc/app/ui.js",
];

const missingCommands = requiredCommands.filter((command) => {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], {stdio: "ignore"});
  return result.status !== 0;
});
const missingPaths = requiredPaths.filter((filePath) => !fs.existsSync(filePath));

if (missingCommands.length || missingPaths.length) {
  if (missingCommands.length) console.error(`missing Chrome runtime commands: ${missingCommands.join(", ")}`);
  if (missingPaths.length) console.error(`missing Chrome runtime assets: ${missingPaths.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("Chrome runtime dependencies and noVNC assets are present");
}
