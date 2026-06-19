"use strict";

const path = require("path");
const {createCodexSeededWorkspaceService} = require("./codexSeededWorkspace.service");
const {defaultWorkspaceSkills} = require("./workspaceSkillCatalog");

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
  const seeds = [];

  if (config.workspaceSourceMode === "blank") {
    seeds.push(seededFile("workspace-agents", "AGENTS.md"));
  }

  for (const skill of defaultWorkspaceSkills(config)) {
    seeds.push({
      ...skill,
      targetPath: path.join(".agents", "skills", skill.name, "SKILL.md"),
    });
  }

  return seeds;
}

module.exports = {
  createCodexService,
  defaultWorkspaceSeeds,
};
