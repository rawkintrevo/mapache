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
    const skills = await discoverWorkspaceSkills(harness);

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
    discoveryRoots: skillDiscoveryRoots(harness.id, config),
    legacyFileSupport: Boolean(harness.skills.legacyFileSupport),
    restartHint: harness.skills.restartHint,
  };
}

function skillDiscoveryRoots(harnessId, config = {}) {
  const workspaceDir = path.resolve(config.workspaceDir || "/workspace");
  const homeDir = path.resolve(config.homeDir || "/root");
  const commonProjectRoot = path.join(workspaceDir, ".agents", "skills");
  const commonUserRoot = path.join(homeDir, ".agents", "skills");
  if (harnessId === "pi") {
    return uniqueRoots([
      {absolutePath: path.join(workspaceDir, ".pi", "skills"), displayPath: ".pi/skills", editable: true, legacyFileSupport: true, scope: "workspace"},
      {absolutePath: commonProjectRoot, displayPath: ".agents/skills", editable: false, scope: "workspace"},
      {absolutePath: path.join(config.piAgentDir || path.join(homeDir, ".pi", "agent"), "skills"), displayPath: "~/.pi/agent/skills", editable: false, scope: "user"},
      {absolutePath: commonUserRoot, displayPath: "~/.agents/skills", editable: false, scope: "user"},
    ]);
  }
  return uniqueRoots([
    {absolutePath: commonProjectRoot, displayPath: ".agents/skills", editable: true, scope: "workspace"},
    {absolutePath: path.join(config.codexHomeDir || path.join(homeDir, ".codex"), "skills"), displayPath: "$CODEX_HOME/skills", editable: false, scope: "user"},
    {absolutePath: commonUserRoot, displayPath: "~/.agents/skills", editable: false, scope: "user"},
  ]);
}

function uniqueRoots(roots) {
  const seen = new Set();
  return roots.filter((root) => {
    const resolved = path.resolve(root.absolutePath);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    root.absolutePath = resolved;
    return true;
  });
}

async function discoverWorkspaceSkills(harness) {
  const skills = [];
  const seenFiles = new Set();
  const seenNames = new Set();
  for (const root of harness.discoveryRoots) {
    const files = await findSkillFiles(root.absolutePath, {legacyFileSupport: root.legacyFileSupport});
    for (const file of files) {
      let canonicalPath = file.absolutePath;
      try {
        canonicalPath = await fs.promises.realpath(file.absolutePath);
      } catch (_error) {}
      if (seenFiles.has(canonicalPath)) continue;
      const content = await readSkillMarkdown(file.absolutePath);
      const fallbackName = file.legacy ? path.basename(file.absolutePath, ".md") : path.basename(path.dirname(file.absolutePath));
      const summary = skillSummaryFromMarkdown(content, {
        path: `${root.displayPath}/${file.relativePath.split(path.sep).join("/")}`,
        kind: file.legacy ? "file" : "directory",
        editable: root.editable,
        fallbackName,
      });
      if (seenNames.has(summary.name)) continue;
      seenFiles.add(canonicalPath);
      seenNames.add(summary.name);
      skills.push({...summary, discovered: true, scope: root.scope, sourceRoot: root.displayPath});
    }
  }
  return skills;
}

async function findSkillFiles(rootPath, {legacyFileSupport = false} = {}) {
  const files = [];
  const visitedDirectories = new Set();
  async function visit(directory, depth) {
    if (depth > 12) return;
    let canonicalDirectory = directory;
    try {
      canonicalDirectory = await fs.promises.realpath(directory);
    } catch (_error) {}
    if (visitedDirectories.has(canonicalDirectory)) return;
    visitedDirectories.add(canonicalDirectory);
    const entries = await safeReadDir(directory);
    const nativeSkill = entries.find((entry) => entry.name === "SKILL.md");
    if (nativeSkill) {
      const nativeSkillPath = path.join(directory, nativeSkill.name);
      let nativeSkillStat = null;
      try {
        nativeSkillStat = await fs.promises.stat(nativeSkillPath);
      } catch (_error) {}
      if (nativeSkillStat?.isFile()) {
        files.push({absolutePath: nativeSkillPath, relativePath: path.relative(rootPath, nativeSkillPath), legacy: false});
        return;
      }
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      let entryStat = null;
      try {
        entryStat = entry.isSymbolicLink() ? await fs.promises.stat(entryPath) : entry;
      } catch (_error) {
        continue;
      }
      if (legacyFileSupport && depth === 0 && entryStat.isFile() && entry.name.endsWith(".md")) {
        files.push({absolutePath: entryPath, relativePath: entry.name, legacy: true});
      } else if (entryStat.isDirectory() && entry.name !== "node_modules") {
        await visit(entryPath, depth + 1);
      }
    }
  }
  await visit(rootPath, 0);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
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
  discoverWorkspaceSkills,
  findSkillFiles,
  readSkillMarkdown,
  skillDiscoveryRoots,
  workspaceSkillHarness,
};
