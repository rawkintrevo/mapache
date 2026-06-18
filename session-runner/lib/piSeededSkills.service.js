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
    const skills = defaultRuntimeSkills(config);
    if (!skills.length) return;

    const skillsPath = path.join(config.workspaceDir, ".pi", "skills");
    await fs.promises.mkdir(skillsPath, {recursive: true});

    for (const skill of skills) {
      const skillDir = path.join(skillsPath, skill.name);
      const skillPath = path.join(skillDir, "SKILL.md");
      if (await pathExists(skillPath)) continue;
      await fs.promises.mkdir(skillDir, {recursive: true});
      const content = await resolveSeededSkillContentIfAvailable(skill);
      if (content === null) continue;
      await fs.promises.writeFile(skillPath, content, "utf8");
    }
  }

  return {
    seedDefaultRuntimeSkills,
  };
}

async function resolveSeededSkillContentIfAvailable(skill) {
  try {
    return await resolveSeededSkillContent(skill);
  } catch (error) {
    if (error && error.code === "ENOENT" && typeof skill.filePath === "string") {
      console.warn(`seeded skill file missing, skipping ${skill.name}: ${skill.filePath}`);
      return null;
    }
    throw error;
  }
}

module.exports = {
  createPiSeededSkillService,
  resolveSeededSkillContent,
  resolveSeededSkillContentIfAvailable,
};
