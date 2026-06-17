"use strict";

const {normalizeRelativeWorkspacePath} = require("./utils");

function skillSummaryFromMarkdown(markdown, options = {}) {
  const frontmatter = parseSkillFrontmatter(markdown);
  const name = safePiSkillName(frontmatter.name || options.fallbackName || "");
  const description = String(frontmatter.description || "").trim().slice(0, 1024);
  return {
    name,
    description,
    path: options.path || "",
    kind: options.kind || "file",
    editable: Boolean(options.editable),
    content: markdown,
  };
}

function parseSkillFrontmatter(markdown) {
  const match = String(markdown || "").match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return {};
  return match[1].split("\n").reduce((acc, line) => {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) return acc;
    acc[field[1]] = field[2].replace(/^['\"]|['\"]$/g, "").trim();
    return acc;
  }, {});
}

function safePiSkillName(value) {
  try {
    return normalizePiSkillName(value);
  } catch (error) {
    return "unnamed-skill";
  }
}

function normalizePiSkillName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    const error = new Error("invalid_skill_name");
    error.code = "invalid_skill_name";
    throw error;
  }
  return name;
}

function normalizePiSkillDescription(value) {
  const description = String(value || "").trim();
  if (!description || description.length > 1024 || /[\u0000-\u001f\u007f]/.test(description)) {
    const error = new Error("invalid_skill_description");
    error.code = "invalid_skill_description";
    throw error;
  }
  return description;
}

function normalizePiSkillContent(value) {
  const content = String(value || "").trim();
  if (!content || content.length > 128 * 1024 || /\u0000/.test(content)) {
    const error = new Error("invalid_skill_content");
    error.code = "invalid_skill_content";
    throw error;
  }
  return content;
}

function buildPiSkillMarkdown({name, description, content}) {
  const body = String(content || "").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  return `---\nname: ${name}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n${body}\n`;
}

function normalizePiMutationPackageSource(source) {
  const normalized = String(source || "").trim();
  if (!normalized || normalized.length > 2048 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    const error = new Error("invalid_package_source");
    error.code = "invalid_package_source";
    throw error;
  }
  if (hasPackageSourceCredentials(normalized)) {
    const error = new Error("invalid_package_source");
    error.code = "invalid_package_source";
    throw error;
  }
  const parsed = classifyPiPackageSource(normalized);
  if (parsed.type !== "npm" && parsed.type !== "git") {
    const error = new Error("unsupported_package_source");
    error.code = "unsupported_package_source";
    throw error;
  }
  if (parsed.type === "npm" && !/^(@[^/]+\/[^@/]+|[^@/]+)(?:@[^\s/]+)?$/.test(normalized.slice("npm:".length))) {
    const error = new Error("invalid_package_source");
    error.code = "invalid_package_source";
    throw error;
  }
  return normalized;
}

function hasPackageSourceCredentials(source) {
  const candidate = source.startsWith("git+") ? source.slice("git+".length) : source;
  try {
    const parsed = new URL(candidate.startsWith("git:") ? candidate.slice("git:".length) : candidate);
    return Boolean(parsed.username || parsed.password);
  } catch (error) {
    return false;
  }
}

function normalizePiPackageSettingsEntry(entry, scope = "workspace") {
  const source = typeof entry === "string" ? entry : entry && typeof entry.source === "string" ? entry.source : "";
  const safeSource = redactPackageSource(source.trim());
  if (!safeSource) return null;

  const filters = typeof entry === "object" && entry && !Array.isArray(entry) ? {...entry} : {};
  delete filters.source;
  Object.keys(filters).forEach((key) => {
    if (filters[key] === undefined || filters[key] === null) delete filters[key];
  });

  return {
    source: safeSource,
    scope,
    type: classifyPiPackageSource(safeSource).type,
    installedPath: null,
    filtered: Object.keys(filters).length > 0,
  };
}

function redactPackageSource(source) {
  if (!source) return "";
  const gitPrefix = source.startsWith("git+") ? "git+" : "";
  const candidate = gitPrefix ? source.slice(gitPrefix.length) : source;
  try {
    const parsed = new URL(candidate);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return `${gitPrefix}${parsed.toString()}`;
    }
  } catch (error) {
    // Non-URL package sources are expected for npm and git shorthand packages.
  }
  return source;
}

function classifyPiPackageSource(source) {
  if (source.startsWith("npm:")) {
    const spec = source.slice("npm:".length).trim();
    const npmMatch = spec.match(/^(@[^/]+\/[^@]+|[^@]+)(?:@(.+))?$/);
    return {type: "npm", name: npmMatch ? npmMatch[1] : spec};
  }

  const gitSource = parsePiGitPackageSource(source);
  if (gitSource) return {type: "git", ...gitSource};

  return {type: "local", localPath: source};
}

function parsePiGitPackageSource(source) {
  const withoutGitPrefix = source.startsWith("git:") ? source.slice("git:".length) : source;
  const withoutGitPlus = withoutGitPrefix.startsWith("git+") ? withoutGitPrefix.slice("git+".length) : withoutGitPrefix;
  const withoutRef = withoutGitPlus.split("#")[0];

  const sshMatch = withoutRef.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) return buildPiGitPackageSource(sshMatch[1], sshMatch[2]);

  const githubShorthand = withoutRef.match(/^github:([^/]+\/.+)$/);
  if (githubShorthand) return buildPiGitPackageSource("github.com", githubShorthand[1]);

  try {
    const parsed = new URL(withoutRef);
    if (["git:", "https:", "http:", "ssh:"].includes(parsed.protocol)) {
      return buildPiGitPackageSource(parsed.hostname, parsed.pathname.replace(/^\/+/, ""));
    }
  } catch (error) {
    // Not a URL-shaped git source.
  }

  return null;
}

function buildPiGitPackageSource(host, gitPath) {
  const normalizedHost = String(host || "").toLowerCase();
  const normalizedPath = normalizeRelativeWorkspacePath(String(gitPath || "").replace(/\.git$/, ""));
  const parts = normalizedPath.split("/").filter(Boolean);
  if (!normalizedHost || !parts.length || parts.some((part) => part === "." || part === "..")) return null;
  return {host: normalizedHost, gitPath: parts.join("/")};
}

module.exports = {
  buildPiSkillMarkdown,
  classifyPiPackageSource,
  normalizePiMutationPackageSource,
  normalizePiPackageSettingsEntry,
  normalizePiSkillContent,
  normalizePiSkillDescription,
  normalizePiSkillName,
  parseSkillFrontmatter,
  redactPackageSource,
  skillSummaryFromMarkdown,
};
