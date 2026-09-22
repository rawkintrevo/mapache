"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const AUTOMATION_STORAGE_MODE = "automation-readonly-gcs-v1";

function isAutomationStorageMode(value) {
  return value === AUTOMATION_STORAGE_MODE;
}

async function assertAutomationStorageMounts(config, {fsImpl = fs} = {}) {
  if (!isAutomationStorageMode(config.workspaceStorageMode)) return;
  const output = config.automationOutputDir;
  if (config.runtimeKind !== "automation" || !/^\/automation-output\/[a-f0-9-]{36}$/.test(output || "")) {
    throw storageError("automation_output_path_invalid");
  }
  for (const directory of [config.workspaceDir, output]) {
    // Refuse a local fallback: output must survive removal of this container.
    const stat = await fsImpl.promises.statfs(directory);
    if (Number(stat.type) !== 0x65735546) throw storageError("automation_storage_mount_missing");
  }
  const inputProbe = path.join(config.workspaceDir, `.automation-readonly-probe-${crypto.randomUUID()}`);
  try {
    await fsImpl.promises.writeFile(inputProbe, "", {flag: "wx"});
  } catch (error) {
    if (error.code !== "EROFS") throw error;
    const outputProbe = path.join(output, `.write-probe-${crypto.randomUUID()}`);
    await fsImpl.promises.writeFile(outputProbe, "", {flag: "wx"});
    await fsImpl.promises.unlink(outputProbe);
    return;
  }
  await fsImpl.promises.unlink(inputProbe);
  throw storageError("automation_workspace_not_read_only");
}

function automationPrompt(prompt, config) {
  if (!isAutomationStorageMode(config.workspaceStorageMode)) return prompt;
  return `Workspace files are available read-only at ${config.workspaceDir}. ` +
    `Your working directory and persistent output folder is ${config.automationOutputDir}. ` +
    "Write all task outputs there. Copy any input you need to edit into that folder first. " +
    "Outputs are kept separately; they are not merged into the workspace automatically.\n\n" + prompt;
}

function storageError(code) {
  return Object.assign(new Error(code), {code});
}

module.exports = {AUTOMATION_STORAGE_MODE, assertAutomationStorageMounts, automationPrompt, isAutomationStorageMode};
