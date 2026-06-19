"use strict";

const path = require("path");
const {createCodexSeededWorkspaceService} = require("./codexSeededWorkspace.service");

function createCodexService({config}) {
  const seededWorkspaceService = createCodexSeededWorkspaceService({config, defaultWorkspaceSeeds});
  return {
    ...seededWorkspaceService,
  };
}

const SEEDED_CODEX_DIR = path.join(__dirname, "..", "seeded-codex");

function seededFile(name, targetPath) {
  return {
    name,
    targetPath,
    filePath: path.join(SEEDED_CODEX_DIR, targetPath),
  };
}

function defaultWorkspaceSeeds(config = {}) {
  const capabilities = config.runnerCapabilities || config || {};
  const seeds = [];

  if (config.workspaceSourceMode === "blank") {
    seeds.push(seededFile("workspace-agents", "AGENTS.md"));
  }

  if (config.workspaceSourceMode === "github") {
    seeds.push(seededFile("mapache-github-issue", path.join(".agents", "skills", "mapache-github-issue", "SKILL.md")));
  }

  if (capabilities.preview) {
    seeds.push(
        seededFile("mapache-preview-build", path.join(".agents", "skills", "mapache-preview-build", "SKILL.md")),
        seededFile("mapache-api-hosting", path.join(".agents", "skills", "mapache-api-hosting", "SKILL.md")),
        seededFile("mapache-preview-qa", path.join(".agents", "skills", "mapache-preview-qa", "SKILL.md")),
    );
  }

  return seeds;
}

module.exports = {
  createCodexService,
  defaultWorkspaceSeeds,
};
