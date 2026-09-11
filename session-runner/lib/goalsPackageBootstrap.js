"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_GOAL_PACKAGE_VERSION = "0.31.2";

/**
 * Re-add the image-owned goal package to restored Pi settings without running
 * a package manager. The image owns the installed files; this only reconciles
 * the declaration that Pi uses during extension discovery.
 */
function createGoalsPackageBootstrap({config = {}, fsModule = fs, version = DEFAULT_GOAL_PACKAGE_VERSION} = {}) {
  const packageSource = `npm:pi-goal-x@${version}`;

  async function ensureInstalledDeclaration() {
    if (config.agentRuntimeEnabled === true) return {enabled: false, reason: "agent_runtime_enabled"};
    const harness = String(config.harnessId || config.terminalKind || "").trim().toLowerCase();
    if (harness !== "pi") return {enabled: false, reason: "unsupported_harness"};
    if (String(process.env.GOAL_BRIDGE_ENABLED || "").toLowerCase() !== "true") {
      return {enabled: false, reason: "goal_bridge_disabled"};
    }

    const agentDir = config.piAgentDir || path.join(config.homeDir || "/root", ".pi", "agent");
    const installedPath = path.join(agentDir, "npm", "node_modules", "pi-goal-x");
    if (!await pathExists(fsModule, installedPath)) {
      return {enabled: false, reason: "managed_package_missing", packageSource};
    }

    const settingsPath = path.join(agentDir, "settings.json");
    const settings = await readSettings(fsModule, settingsPath);
    const packages = Array.isArray(settings.packages) ? settings.packages : [];
    const retained = packages.filter((entry) => !isGoalPackageSource(entry));
    retained.push(packageSource);
    const changed = retained.length !== packages.length ||
      retained.some((entry, index) => entry !== packages[index]);
    if (changed || !Array.isArray(settings.packages)) {
      settings.packages = retained;
      await writeSettings(fsModule, settingsPath, settings);
    }
    return {enabled: true, changed, packageSource, settingsPath};
  }

  return {ensureInstalledDeclaration, packageSource};
}

function isGoalPackageSource(entry) {
  const source = typeof entry === "string" ? entry : entry && entry.source;
  return typeof source === "string" && /^npm:pi-goal-x(?:@|$)/.test(source.trim());
}

async function readSettings(fsModule, settingsPath) {
  try {
    const raw = await fsModule.promises.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    if (error instanceof SyntaxError) throw new Error("pi_settings_invalid_json");
    throw error;
  }
}

async function pathExists(fsModule, target) {
  try {
    await fsModule.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

async function writeSettings(fsModule, settingsPath, settings) {
  const directory = path.dirname(settingsPath);
  await fsModule.promises.mkdir(directory, {recursive: true, mode: 0o700});
  const temporaryPath = `${settingsPath}.mapache-${process.pid}-${Date.now()}.tmp`;
  try {
    await fsModule.promises.writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {mode: 0o600});
    await fsModule.promises.rename(temporaryPath, settingsPath);
  } finally {
    await fsModule.promises.rm(temporaryPath, {force: true}).catch(() => {});
  }
}

module.exports = {
  DEFAULT_GOAL_PACKAGE_VERSION,
  createGoalsPackageBootstrap,
  isGoalPackageSource,
};
