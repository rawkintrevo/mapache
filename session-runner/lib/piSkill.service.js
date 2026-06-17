"use strict";

const fs = require("fs");
const path = require("path");
const {pathExists, safeReadDir} = require("./utils");
const {
  buildPiSkillMarkdown,
  normalizePiSkillContent,
  normalizePiSkillDescription,
  normalizePiSkillName,
  skillSummaryFromMarkdown,
} = require("./piValidation.helpers");

function createPiSkillService({config, syncUp}) {
  async function listWorkspacePiSkills() {
    const skillsPath = path.join(config.workspaceDir, ".pi", "skills");
    const skills = [];
    const entries = await safeReadDir(skillsPath);

    for (const entry of entries) {
      const entryPath = path.join(skillsPath, entry.name);
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const content = await readSkillMarkdown(entryPath);
        skills.push(skillSummaryFromMarkdown(content, {
          path: `.pi/skills/${entry.name}`,
          kind: "file",
          editable: true,
          fallbackName: entry.name.replace(/\.md$/i, ""),
        }));
        continue;
      }
      if (entry.isDirectory()) {
        const skillPath = path.join(entryPath, "SKILL.md");
        if (await pathExists(skillPath)) {
          const content = await readSkillMarkdown(skillPath);
          skills.push(skillSummaryFromMarkdown(content, {
            path: `.pi/skills/${entry.name}/SKILL.md`,
            kind: "directory",
            editable: true,
            fallbackName: entry.name,
          }));
        }
      }
    }

    return {
      ok: true,
      scope: "workspace",
      skillsPath,
      skills: skills.sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  async function saveWorkspacePiSkill(body) {
    const name = normalizePiSkillName(body.name);
    const description = normalizePiSkillDescription(body.description);
    const instructions = normalizePiSkillContent(body.content || body.instructions || "");
    const skillsPath = path.join(config.workspaceDir, ".pi", "skills");
    const skillDir = path.join(skillsPath, name);
    const skillPath = path.join(skillDir, "SKILL.md");
    await fs.promises.mkdir(skillDir, {recursive: true});
    const markdown = buildPiSkillMarkdown({name, description, content: instructions});
    await fs.promises.writeFile(skillPath, markdown, "utf8");
    await syncUp({includeArchives: false});
    return {
      ok: true,
      action: "save",
      skill: skillSummaryFromMarkdown(markdown, {
        path: `.pi/skills/${name}/SKILL.md`,
        kind: "directory",
        editable: true,
        fallbackName: name,
      }),
      skills: (await listWorkspacePiSkills()).skills,
    };
  }

  async function deleteWorkspacePiSkill(body) {
    const name = normalizePiSkillName(body.name);
    const skillsPath = path.join(config.workspaceDir, ".pi", "skills");
    const skillDir = path.join(skillsPath, name);
    const skillPath = path.join(skillDir, "SKILL.md");
    if (!await pathExists(skillPath)) {
      const rootMdPath = path.join(skillsPath, `${name}.md`);
      if (!await pathExists(rootMdPath)) {
        const error = new Error("skill_not_found");
        error.code = "skill_not_found";
        throw error;
      }
      await fs.promises.unlink(rootMdPath);
    } else {
      await fs.promises.rm(skillDir, {recursive: true, force: true});
    }
    await syncUp({includeArchives: false});
    return {
      ok: true,
      action: "delete",
      name,
      skills: (await listWorkspacePiSkills()).skills,
    };
  }

  return {
    deleteWorkspacePiSkill,
    listWorkspacePiSkills,
    saveWorkspacePiSkill,
  };
}

async function readSkillMarkdown(skillPath) {
  const stat = await fs.promises.stat(skillPath);
  if (stat.size > 256 * 1024) {
    const error = new Error("invalid_skill_content");
    error.code = "invalid_skill_content";
    throw error;
  }
  return fs.promises.readFile(skillPath, "utf8");
}

module.exports = {
  createPiSkillService,
  readSkillMarkdown,
};
