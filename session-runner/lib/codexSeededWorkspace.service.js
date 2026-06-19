"use strict";

const fs = require("fs");
const path = require("path");
const {pathExists} = require("./utils");
const {
  buildPiSkillMarkdown,
  normalizePiSkillName,
  parseSkillFrontmatter,
} = require("./piValidation.helpers");

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
    for (const seed of seeds) {
      const targetPath = path.join(config.workspaceDir, seed.targetPath);
      if (await pathExists(targetPath)) continue;
      await fs.promises.mkdir(path.dirname(targetPath), {recursive: true});
      const content = await resolveSeedContentIfAvailable(seed);
      if (content === null) continue;
      await fs.promises.writeFile(targetPath, content, "utf8");
    }

    await importPiSkillsForCodex();
  }

  async function importPiSkillsForCodex() {
    const piSkillsPath = path.join(config.workspaceDir, ".pi", "skills");
    const entries = await safeReadDir(piSkillsPath);
    if (!entries.length) return;

    for (const entry of entries) {
      const sourcePath = await piSkillSourcePath(piSkillsPath, entry);
      if (!sourcePath) continue;
      const markdown = await readSmallTextFile(sourcePath);
      const content = normalizeCodexSkillMarkdown(markdown, entry.name);
      if (!content) continue;

      const name = skillNameForCodex(content, entry.name);
      if (!name) continue;

      const targetPath = path.join(config.workspaceDir, ".agents", "skills", name, "SKILL.md");
      if (await pathExists(targetPath)) continue;
      await fs.promises.mkdir(path.dirname(targetPath), {recursive: true});
      await fs.promises.writeFile(targetPath, content, "utf8");
    }
  }

  return {
    importPiSkillsForCodex,
    seedDefaultWorkspaceFiles,
  };
}

async function safeReadDir(dir) {
  try {
    return await fs.promises.readdir(dir, {withFileTypes: true});
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function piSkillSourcePath(skillsPath, entry) {
  const entryPath = path.join(skillsPath, entry.name);
  if (entry.isFile() && entry.name.endsWith(".md")) return entryPath;
  if (!entry.isDirectory()) return "";
  const skillPath = path.join(entryPath, "SKILL.md");
  return await pathExists(skillPath) ? skillPath : "";
}

async function readSmallTextFile(filePath) {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > 256 * 1024) return "";
  return fs.promises.readFile(filePath, "utf8");
}

function normalizeCodexSkillMarkdown(markdown, fallbackName) {
  const value = String(markdown || "").trim();
  if (!value) return "";

  const frontmatter = parseSkillFrontmatter(value);
  const safeName = safeSkillName(frontmatter.name || fallbackName.replace(/\.md$/i, ""));
  if (!safeName) return "";

  const body = value.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  if (!body) return "";

  const description = String(frontmatter.description || "").trim() || `Imported Pi skill: ${safeName}`;
  return buildPiSkillMarkdown({
    name: safeName,
    description,
    content: body,
  });
}

function skillNameForCodex(markdown, fallbackName) {
  const frontmatter = parseSkillFrontmatter(markdown);
  return safeSkillName(frontmatter.name || fallbackName.replace(/\.md$/i, ""));
}

function safeSkillName(value) {
  try {
    return normalizePiSkillName(value);
  } catch {
    return "";
  }
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
  normalizeCodexSkillMarkdown,
  resolveSeedContent,
  resolveSeedContentIfAvailable,
};
