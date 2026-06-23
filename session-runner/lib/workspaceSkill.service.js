"use strict";

const fs = require("fs");
const path = require("path");
const {resolveHarnessMetadata} = require("./harnesses/metadata");
const {pathExists, safeReadDir} = require("./utils");
const {
  buildPiSkillMarkdown,
  normalizePiSkillContent,
  normalizePiSkillDescription,
  normalizePiSkillName,
  skillSummaryFromMarkdown,
} = require("./piValidation.helpers");

function createWorkspaceSkillService({config, syncUp}) {
  const harness = workspaceSkillHarness(config);

  async function listWorkspaceSkills() {
    const skillsPath = harness.skillsPath;
    const skills = [];
    const entries = await safeReadDir(skillsPath);

    for (const entry of entries) {
      const entryPath = path.join(skillsPath, entry.name);
      if (harness.legacyFileSupport && entry.isFile() && entry.name.endsWith(".md")) {
        const content = await readSkillMarkdown(entryPath);
        skills.push(skillSummaryFromMarkdown(content, {
          path: `${harness.relativeSkillsPath}/${entry.name}`,
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
            path: `${harness.relativeSkillsPath}/${entry.name}/SKILL.md`,
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
      harness: harness.id,
      harnessLabel: harness.label,
      requiresRestart: true,
      restartHint: harness.restartHint,
      skillsRelativePath: harness.relativeSkillsPath,
      skillsPath,
      skills: skills.sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  async function saveWorkspaceSkill(body) {
    const name = normalizePiSkillName(body.name);
    const description = normalizePiSkillDescription(body.description);
    const instructions = normalizePiSkillContent(body.content || body.instructions || "");
    const skillsPath = harness.skillsPath;
    const skillDir = path.join(skillsPath, name);
    const skillPath = path.join(skillDir, "SKILL.md");
    await fs.promises.mkdir(skillDir, {recursive: true});
    const markdown = buildPiSkillMarkdown({name, description, content: instructions});
    await fs.promises.writeFile(skillPath, markdown, "utf8");
    await syncUp({includeArchives: false});
    return {
      ok: true,
      action: "save",
      harness: harness.id,
      harnessLabel: harness.label,
      requiresRestart: true,
      restartHint: harness.restartHint,
      skillsRelativePath: harness.relativeSkillsPath,
      skill: skillSummaryFromMarkdown(markdown, {
        path: `${harness.relativeSkillsPath}/${name}/SKILL.md`,
        kind: "directory",
        editable: true,
        fallbackName: name,
      }),
      skills: (await listWorkspaceSkills()).skills,
    };
  }

  async function deleteWorkspaceSkill(body) {
    const name = normalizePiSkillName(body.name);
    const skillsPath = harness.skillsPath;
    const skillDir = path.join(skillsPath, name);
    const skillPath = path.join(skillDir, "SKILL.md");
    if (!await pathExists(skillPath)) {
      const rootMdPath = path.join(skillsPath, `${name}.md`);
      if (!harness.legacyFileSupport || !await pathExists(rootMdPath)) {
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
      harness: harness.id,
      harnessLabel: harness.label,
      requiresRestart: true,
      restartHint: harness.restartHint,
      skillsRelativePath: harness.relativeSkillsPath,
      name,
      skills: (await listWorkspaceSkills()).skills,
    };
  }

  return {
    deleteWorkspaceSkill,
    listWorkspaceSkills,
    saveWorkspaceSkill,
  };
}

function workspaceSkillHarness(config = {}) {
  const harness = resolveHarnessMetadata(config);
  if (!harness.skills?.supported) {
    const error = new Error("runner_skill_listing_unsupported");
    error.code = "runner_skill_listing_unsupported";
    throw error;
  }
  return {
    id: harness.id,
    label: harness.label,
    relativeSkillsPath: harness.skills.relativePath,
    skillsPath: harness.skills.absolutePath(config),
    legacyFileSupport: Boolean(harness.skills.legacyFileSupport),
    restartHint: harness.skills.restartHint,
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
  createWorkspaceSkillService,
  readSkillMarkdown,
  workspaceSkillHarness,
};
