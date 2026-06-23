"use strict";

const fs = require("fs");
const path = require("path");
const {resolveHarnessMetadata} = require("./harnesses/metadata");
const {pathExists, safeReadDir} = require("./utils");

function createWorkspaceSubagentService({config, syncUp}) {
  const harness = workspaceSubagentHarness(config);

  async function listWorkspaceSubagents() {
    const files = await listSubagentFiles(harness.subagentsPath, harness.fileExtension);
    const subagents = [];
    for (const filePath of files) {
      const content = await readSmallTextFile(filePath);
      const summary = harness.schema === "codex-agent-toml" ?
        codexSubagentSummary(content, relativeSubagentPath(harness, filePath)) :
        piSubagentSummary(content, relativeSubagentPath(harness, filePath));
      if (summary) subagents.push(summary);
    }
    subagents.sort((left, right) => left.name.localeCompare(right.name));
    return {
      ok: true,
      harness: harness.id,
      harnessLabel: harness.label,
      schema: harness.schema,
      requiresRestart: true,
      restartHint: harness.restartHint,
      subagentsRelativePath: harness.relativePath,
      chainsRelativePath: harness.chainsRelativePath,
      settingsRelativePath: harness.settingsRelativePath,
      configPath: harness.configPath,
      subagents,
    };
  }

  async function saveWorkspaceSubagent(body) {
    const normalized = normalizeWorkspaceSubagentPayload(body);
    const targetPath = path.join(harness.subagentsPath, `${normalized.name}${harness.fileExtension}`);
    await fs.promises.mkdir(path.dirname(targetPath), {recursive: true});
    const content = harness.schema === "codex-agent-toml" ?
      buildCodexSubagentToml(normalized) :
      buildPiSubagentMarkdown(normalized);
    await fs.promises.writeFile(targetPath, content, "utf8");
    await syncUp({includeArchives: false});
    const listed = await listWorkspaceSubagents();
    return {
      ok: true,
      action: "save",
      harness: harness.id,
      harnessLabel: harness.label,
      schema: harness.schema,
      requiresRestart: true,
      restartHint: harness.restartHint,
      subagentsRelativePath: harness.relativePath,
      chainsRelativePath: harness.chainsRelativePath,
      settingsRelativePath: harness.settingsRelativePath,
      configPath: harness.configPath,
      subagent: listed.subagents.find((item) => item.name === normalized.name) || null,
      subagents: listed.subagents,
    };
  }

  async function deleteWorkspaceSubagent(body) {
    const name = normalizeWorkspaceSubagentName(body.name);
    const targetPath = path.join(harness.subagentsPath, `${name}${harness.fileExtension}`);
    if (!await pathExists(targetPath)) {
      const error = new Error("subagent_not_found");
      error.code = "subagent_not_found";
      throw error;
    }
    await fs.promises.unlink(targetPath);
    await syncUp({includeArchives: false});
    const listed = await listWorkspaceSubagents();
    return {
      ok: true,
      action: "delete",
      harness: harness.id,
      harnessLabel: harness.label,
      schema: harness.schema,
      requiresRestart: true,
      restartHint: harness.restartHint,
      subagentsRelativePath: harness.relativePath,
      chainsRelativePath: harness.chainsRelativePath,
      settingsRelativePath: harness.settingsRelativePath,
      configPath: harness.configPath,
      name,
      subagents: listed.subagents,
    };
  }

  async function listWorkspaceSubagentChains() {
    return {
      ok: true,
      harness: harness.id,
      harnessLabel: harness.label,
      schema: harness.schema,
      requiresRestart: true,
      restartHint: harness.restartHint,
      subagentsRelativePath: harness.relativePath,
      chainsRelativePath: harness.chainsRelativePath,
      settingsRelativePath: harness.settingsRelativePath,
      configPath: harness.configPath,
      chains: [],
    };
  }

  async function unsupportedChainsMutation() {
    const error = new Error("subagent_chains_write_unsupported");
    error.code = "subagent_chains_write_unsupported";
    throw error;
  }

  return {
    deleteWorkspaceSubagent,
    deleteWorkspaceSubagentChain: unsupportedChainsMutation,
    listWorkspaceSubagentChains,
    listWorkspaceSubagents,
    saveWorkspaceSubagent,
    saveWorkspaceSubagentChain: unsupportedChainsMutation,
  };
}

function workspaceSubagentHarness(config = {}) {
  const harness = resolveHarnessMetadata(config);
  if (!harness.subagents?.supported) {
    const error = new Error("runner_subagent_listing_unsupported");
    error.code = "runner_subagent_listing_unsupported";
    throw error;
  }
  return {
    id: harness.id,
    label: harness.label,
    schema: harness.subagents.schema,
    relativePath: harness.subagents.relativePath,
    subagentsPath: harness.subagents.absolutePath(config),
    fileExtension: harness.subagents.fileExtension,
    restartHint: harness.subagents.restartHint,
    chainsRelativePath: harness.subagents.chainsRelativePath || "",
    settingsRelativePath: harness.subagents.settingsRelativePath || "",
    configPath: harness.subagents.configPath || "",
  };
}

async function listSubagentFiles(rootPath, extension) {
  const results = [];
  await walkSubagentFiles(rootPath, extension, results);
  return results;
}

async function walkSubagentFiles(rootPath, extension, results) {
  const entries = await safeReadDir(rootPath);
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await walkSubagentFiles(entryPath, extension, results);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(extension)) {
      results.push(entryPath);
    }
  }
}

function relativeSubagentPath(harness, filePath) {
  return `${harness.relativePath}/${path.relative(harness.subagentsPath, filePath).replace(/\\/g, "/")}`;
}

async function readSmallTextFile(filePath) {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > 256 * 1024) {
    const error = new Error("invalid_subagent_content");
    error.code = "invalid_subagent_content";
    throw error;
  }
  return fs.promises.readFile(filePath, "utf8");
}

function piSubagentSummary(content, relativePath) {
  const frontmatterMatch = String(content || "").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const frontmatter = frontmatterMatch ? frontmatterMatch[1] : "";
  const instructions = frontmatterMatch ? frontmatterMatch[2].trim() : String(content || "").trim();
  const fields = parseSimpleFrontmatter(frontmatter);
  const name = normalizeWorkspaceSubagentName(fields.name || path.basename(relativePath, ".md"));
  if (!name) return null;
  return {
    name,
    description: String(fields.description || "").trim(),
    instructions,
    path: relativePath,
    schema: "pi-agent-markdown",
  };
}

function codexSubagentSummary(content, relativePath) {
  const text = String(content || "");
  const name = normalizeWorkspaceSubagentName(extractTomlString(text, "name") || path.basename(relativePath, ".toml"));
  if (!name) return null;
  return {
    name,
    description: extractTomlString(text, "description"),
    instructions: extractTomlMultiline(text, "developer_instructions"),
    path: relativePath,
    schema: "codex-agent-toml",
  };
}

function parseSimpleFrontmatter(frontmatter) {
  return String(frontmatter || "").split("\n").reduce((acc, line) => {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) return acc;
    acc[match[1]] = match[2].trim();
    return acc;
  }, {});
}

function extractTomlString(text, key) {
  const match = String(text || "").match(new RegExp(`^${key}\\s*=\\s*\"([\\s\\S]*?)\"$`, "m"));
  return match ? match[1] : "";
}

function extractTomlMultiline(text, key) {
  const match = String(text || "").match(new RegExp(`^${key}\\s*=\\s*\"\"\"\\n([\\s\\S]*?)\\n\"\"\"$`, "m"));
  return match ? match[1].trim() : "";
}

function normalizeWorkspaceSubagentPayload(body = {}) {
  return {
    name: requireWorkspaceSubagentName(body.name),
    description: normalizeWorkspaceSubagentDescription(body.description),
    instructions: normalizeWorkspaceSubagentInstructions(body.instructions || body.content || body.developerInstructions || ""),
  };
}

function normalizeWorkspaceSubagentName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return "";
  return name;
}

function requireWorkspaceSubagentName(value) {
  const name = normalizeWorkspaceSubagentName(value);
  if (!name) {
    const error = new Error("invalid_subagent_name");
    error.code = "invalid_subagent_name";
    throw error;
  }
  return name;
}

function normalizeWorkspaceSubagentDescription(value) {
  const description = String(value || "").trim();
  if (!description || description.length > 1024 || /[\u0000-\u001f\u007f]/.test(description)) {
    const error = new Error("invalid_subagent_description");
    error.code = "invalid_subagent_description";
    throw error;
  }
  return description;
}

function normalizeWorkspaceSubagentInstructions(value) {
  const instructions = String(value || "").trim();
  if (!instructions || instructions.length > 128 * 1024 || /\u0000/.test(instructions)) {
    const error = new Error("invalid_subagent_content");
    error.code = "invalid_subagent_content";
    throw error;
  }
  return instructions;
}

function buildPiSubagentMarkdown(subagent) {
  return [
    "---",
    `name: ${subagent.name}`,
    `description: ${subagent.description}`,
    "---",
    subagent.instructions,
    "",
  ].join("\n");
}

function buildCodexSubagentToml(subagent) {
  return [
    `name = ${JSON.stringify(subagent.name)}`,
    `description = ${JSON.stringify(subagent.description)}`,
    "developer_instructions = \"\"\"",
    subagent.instructions,
    "\"\"\"",
    "",
  ].join("\n");
}

module.exports = {
  buildCodexSubagentToml,
  buildPiSubagentMarkdown,
  createWorkspaceSubagentService,
  workspaceSubagentHarness,
};
