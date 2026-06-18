"use strict";

const path = require("path");
const {spawn} = require("child_process");
const {collectStderr, waitForChild} = require("./processes");
const {compactErrorMessage, pathExists, readJsonFile} = require("./utils");
const {
  classifyPiPackageSource,
  normalizePiMutationPackageSource,
  normalizePiPackageSettingsEntry,
} = require("./piValidation.helpers");

function createPiPackageService({config, syncUp}) {
  async function listWorkspacePiPackages() {
    const settingsPath = path.join(config.workspaceDir, ".pi", "settings.json");
    const userSettingsPath = path.join(config.piAgentDir, "settings.json");
    const settings = await readJsonFile(settingsPath, {});
    const userSettings = await readJsonFile(userSettingsPath, {});
    const packages = await listPiPackageSettingsEntries(settings, "workspace");
    const userPackages = await listPiPackageSettingsEntries(userSettings, "user");

    return {
      ok: true,
      scope: "workspace",
      settingsPath,
      packages,
      userPackages,
    };
  }

  async function listPiPackageSettingsEntries(settings, scope) {
    const packages = Array.isArray(settings.packages) ? settings.packages : [];
    return Promise.all(packages
        .map((entry) => normalizePiPackageSettingsEntry(entry, scope))
        .filter(Boolean)
        .map(async (entry) => ({
          ...entry,
          installedPath: await resolveInstalledPiPackagePath(entry.source, scope),
        })));
  }

  async function installWorkspacePiPackage(body) {
    const source = normalizePiMutationPackageSource(body.source);
    await runPiCommand(["install", "-l", source]);
    await syncUp({includeArchives: true});
    return {
      ok: true,
      action: "install",
      source,
      packages: (await listWorkspacePiPackages()).packages,
    };
  }

  async function removeWorkspacePiPackage(body) {
    const source = normalizePiMutationPackageSource(body.source);
    await runPiCommand(["remove", "-l", source]);
    await syncUp({includeArchives: true});
    return {
      ok: true,
      action: "remove",
      source,
      packages: (await listWorkspacePiPackages()).packages,
    };
  }

  async function updateWorkspacePiPackages(body) {
    const source = body.source ? normalizePiMutationPackageSource(body.source) : "";
    const args = source ? ["update", "--extension", source] : ["update", "--extensions"];
    await runPiCommand(args);
    await syncUp({includeArchives: true});
    return {
      ok: true,
      action: "update",
      source: source || null,
      packages: (await listWorkspacePiPackages()).packages,
    };
  }

  async function runPiCommand(args) {
    const child = spawn("pi", args, {
      cwd: config.workspaceDir,
      stdio: ["ignore", "ignore", "pipe"],
      env: process.env,
    });
    const stderr = collectStderr(child);
    try {
      await waitForChild(child, stderr, `pi ${args[0]}`);
    } catch (error) {
      throw new Error(compactErrorMessage(error.message || error) || "pi_command_failed");
    }
  }

  async function resolveInstalledPiPackagePath(source, scope = "workspace") {
    const parsed = classifyPiPackageSource(source);
    const root = scope === "user" ?
      config.piAgentDir :
      path.join(config.workspaceDir, ".pi");
    if (parsed.type === "npm" && parsed.name) {
      return existingManagedPackagePath(path.join(root, "npm", "node_modules"), [parsed.name]);
    }
    if (parsed.type === "git" && parsed.host && parsed.gitPath) {
      return existingManagedPackagePath(path.join(root, "git"), [parsed.host, ...parsed.gitPath.split("/")]);
    }
    if (parsed.type === "local" && parsed.localPath) {
      const resolved = resolveWorkspacePackagePath(parsed.localPath);
      return resolved && await pathExists(resolved) ? resolved : null;
    }
    return null;
  }

  async function existingManagedPackagePath(root, parts) {
    const resolvedRoot = path.resolve(root);
    const resolvedPath = path.resolve(resolvedRoot, ...parts);
    if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) return null;
    return await pathExists(resolvedPath) ? resolvedPath : null;
  }

  function resolveWorkspacePackagePath(packagePath) {
    const resolvedRoot = path.resolve(config.workspaceDir);
    const resolvedPath = path.resolve(resolvedRoot, packagePath);
    if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) return null;
    return resolvedPath;
  }

  return {
    installWorkspacePiPackage,
    listWorkspacePiPackages,
    removeWorkspacePiPackage,
    updateWorkspacePiPackages,
  };
}

module.exports = {
  createPiPackageService,
};
