"use strict";

const {spawn} = require("child_process");

function collectStderr(child) {
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 4096) stderr = stderr.slice(stderr.length - 4096);
  });
  return () => stderr.trim();
}

async function waitForChild(child, stderr, label) {
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    throw new Error(`${label} failed with exit code ${code}: ${stderr()}`);
  }
}

async function runCommand(file, args, options = {}) {
  const child = spawn(file, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env || process.env,
  });
  const stderr = collectStderr(child);
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    if (stdout.length > (options.stdoutLimit || 8192)) {
      stdout = stdout.slice(stdout.length - (options.stdoutLimit || 8192));
    }
  });
  await waitForChild(child, stderr, `${file} ${args.join(" ")}`);
  return options.captureStdout ? stdout.trim() : "";
}

module.exports = {
  collectStderr,
  runCommand,
  waitForChild,
};
