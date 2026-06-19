"use strict";

const fs = require("fs");
const path = require("path");
const {pathExists} = require("./utils");

async function resolveSeedContent(seed) {
  if (typeof seed.content === "string") return seed.content;
  if (typeof seed.filePath === "string") return fs.promises.readFile(seed.filePath, "utf8");
  const error = new Error("invalid_codex_seed");
  error.code = "invalid_codex_seed";
  throw error;
}

function createCodexSeededWorkspaceService({config, defaultWorkspaceSeeds}) {
  async function seedDefaultWorkspaceFiles() {
    const seeds = defaultWorkspaceSeeds(config);
    if (!seeds.length) return;

    for (const seed of seeds) {
      const targetPath = path.join(config.workspaceDir, seed.targetPath);
      if (await pathExists(targetPath)) continue;
      await fs.promises.mkdir(path.dirname(targetPath), {recursive: true});
      const content = await resolveSeedContentIfAvailable(seed);
      if (content === null) continue;
      await fs.promises.writeFile(targetPath, content, "utf8");
    }
  }

  return {
    seedDefaultWorkspaceFiles,
  };
}

async function resolveSeedContentIfAvailable(seed) {
  try {
    return await resolveSeedContent(seed);
  } catch (error) {
    if (error && error.code === "ENOENT" && typeof seed.filePath === "string") {
      console.warn(`codex seed file missing, skipping ${seed.name}: ${seed.filePath}`);
      return null;
    }
    throw error;
  }
}

module.exports = {
  createCodexSeededWorkspaceService,
  resolveSeedContent,
  resolveSeedContentIfAvailable,
};
