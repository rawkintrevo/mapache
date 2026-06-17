"use strict";

const fs = require("fs");
const path = require("path");
const {pathExists} = require("./utils");

async function resolveSeededSkillContent(skill) {
  if (typeof skill.content === "string") return skill.content;
  if (typeof skill.filePath === "string") {
    return fs.promises.readFile(skill.filePath, "utf8");
  }
  const error = new Error("invalid_seeded_skill");
  error.code = "invalid_seeded_skill";
  throw error;
}

function createPiSeededSkillService({config, defaultRuntimeSkills}) {
  async function seedDefaultRuntimeSkills() {
    const skills = defaultRuntimeSkills(config.runnerCapabilities);
    if (!skills.length) return;

    const skillsPath = path.join(config.workspaceDir, ".pi", "skills");
    await fs.promises.mkdir(skillsPath, {recursive: true});

    for (const skill of skills) {
      const skillDir = path.join(skillsPath, skill.name);
      const skillPath = path.join(skillDir, "SKILL.md");
      if (await pathExists(skillPath)) continue;
      await fs.promises.mkdir(skillDir, {recursive: true});
      await fs.promises.writeFile(skillPath, await resolveSeededSkillContent(skill), "utf8");
    }
  }

  return {
    seedDefaultRuntimeSkills,
  };
}

module.exports = {
  createPiSeededSkillService,
  resolveSeededSkillContent,
};
