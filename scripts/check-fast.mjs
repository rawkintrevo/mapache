import {spawnSync} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const checks = [
  ["developer docs", npm, ["run", "docs:check"]],
  ["Functions syntax", npm, ["--prefix", "functions", "run", "lint"]],
  ["VM automation Functions tests", process.execPath, [
    "--test",
    "functions/automationAdmission.service.test.js",
    "functions/automationCleanup.service.test.js",
    "functions/automationProvisioning.service.test.js",
    "functions/automationReconciliation.service.test.js",
    "functions/automationRuns.service.test.js",
    "functions/automationScheduler.service.test.js",
    "functions/vmLifecycle.adapter.test.js",
    "functions/vmLifecycle.service.test.js",
    "functions/vmWorkspaceRuntime.service.test.js",
    "functions/workspaceRequestRuntime.service.test.js",
  ]],
  ["runner syntax", npm, ["--prefix", "session-runner", "run", "lint"]],
  ["VM automation runner tests", process.execPath, [
    "--test",
    "session-runner/lib/automationExecution.service.test.js",
    "session-runner/lib/automationStorage.helpers.test.js",
    "session-runner/lib/piWebUiProcess.test.js",
    "session-runner/lib/runnerLifecycle.test.js",
    "session-runner/lib/vmAutomationRuntime.service.test.js",
  ]],
];

for (const [name, command, args] of checks) {
  console.log(`\n[check:fast] ${name}`);
  const result = spawnSync(command, args, {cwd: root, env: process.env, stdio: "inherit"});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("\n[check:fast] focused VM automation checks passed");
