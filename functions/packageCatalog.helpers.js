"use strict";

function normalizePiPackageSource(value) {
  const source = String(value || "").trim();
  if (!source || /[\u0000-\u001f\u007f]/.test(source)) throw codeError("invalid_package_source");
  if (source.startsWith("npm:")) return normalizeNpmPackageSource(source);
  const gitSource = normalizeGitPackageSource(source);
  if (gitSource) return gitSource;
  throw codeError("unsupported_package_source");
}

function normalizeNpmPackageSource(source) {
  const spec = source.slice("npm:".length).trim();
  const match = spec.match(/^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@([^\s/]+))?$/i);
  if (!match) throw codeError("invalid_package_source");
  const name = match[1].toLowerCase();
  return {source, type: "npm", identity: `npm:${name}`, name, pinned: Boolean(match[2])};
}

function normalizeGitPackageSource(source) {
  const parsed = parseGitPackageSource(source);
  if (!parsed) return null;
  return {
    source,
    type: "git",
    identity: `git:${parsed.host}/${parsed.path}`,
    host: parsed.host,
    path: parsed.path,
    pinned: Boolean(parsed.ref),
  };
}

function parseGitPackageSource(source) {
  const withoutGitPrefix = source.startsWith("git:") ? source.slice("git:".length) : source;
  const withoutGitPlus = withoutGitPrefix.startsWith("git+") ? withoutGitPrefix.slice("git+".length) : withoutGitPrefix;
  const [withoutRef, ref = ""] = withoutGitPlus.split("#");
  const sshMatch = withoutRef.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) return buildGitPackageSource(sshMatch[1], sshMatch[2], ref);
  const githubShorthand = withoutRef.match(/^github:([^/]+\/.+)$/);
  if (githubShorthand) return buildGitPackageSource("github.com", githubShorthand[1], ref);
  try {
    const parsed = new URL(withoutRef);
    if (parsed.username || parsed.password) throw codeError("package_source_must_not_include_credentials");
    if (["git:", "https:", "ssh:"].includes(parsed.protocol)) {
      return buildGitPackageSource(parsed.hostname, parsed.pathname.replace(/^\/+/, ""), ref);
    }
  } catch (error) {
    if (error && ["invalid_package_source", "package_source_must_not_include_credentials"].includes(error.code)) {
      throw error;
    }
  }
  return null;
}

function buildGitPackageSource(host, gitPath, ref = "") {
  const normalizedHost = String(host || "").trim().toLowerCase();
  const normalizedPath = String(gitPath || "").trim().replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  const parts = normalizedPath.split("/").filter(Boolean);
  if (!normalizedHost || !/^[a-z0-9.-]+$/i.test(normalizedHost) || !parts.length || parts.some((part) => part === "." || part === "..")) {
    throw codeError("invalid_package_source");
  }
  return {host: normalizedHost, path: parts.join("/"), ref: String(ref || "").trim()};
}

function piPackageCatalogDocId(identity) {
  return encodeURIComponent(identity);
}

function buildCatalogMerge(source, workspaceId, options = {}) {
  const normalized = normalizePiPackageSource(source);
  return {
    identity: normalized.identity,
    type: normalized.type,
    source: normalized.source,
    lastWorkspaceId: String(workspaceId || ""),
    installCountIncrement: options.incrementInstallCount ? 1 : 0,
    favorite: options.includeCreatedAt ? false : undefined,
  };
}

function codeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {normalizePiPackageSource, piPackageCatalogDocId, buildCatalogMerge};
