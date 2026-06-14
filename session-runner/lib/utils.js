"use strict";

const fs = require("fs");
const path = require("path");

function normalizePrefix(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function normalizeEnvString(value) {
  return String(value || "").trim();
}

function compactErrorMessage(value) {
  return normalizeEnvString(value).slice(0, 1000) || "unknown_error";
}

function positiveNumber(value, fallback) {
  const number = Number(value || fallback);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function envFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

async function pathExists(localPath) {
  try {
    await fs.promises.access(localPath);
    return true;
  } catch (error) {
    return false;
  }
}

async function safeReadDir(directoryPath) {
  try {
    return await fs.promises.readdir(directoryPath, {withFileTypes: true});
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

function safePathInRoot(root, filePath) {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(filePath);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`);
}

function normalizeRelativeWorkspacePath(relativePath) {
  return String(relativePath || "").split(path.sep).join("/").replace(/^\/+|\/+$/g, "");
}

function parseSyncPolicyExclude(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map((item) => normalizeEnvString(item)).filter(Boolean) : [];
  } catch (error) {
    console.error("invalid WORKSPACE_SYNC_POLICY_EXCLUDE, using no policy exclusions", error);
    return [];
  }
}

function matchesSyncPolicyPattern(relativePath, pattern) {
  const normalizedPath = normalizeRelativeWorkspacePath(relativePath);
  const normalizedPattern = normalizeRelativeWorkspacePath(pattern);
  if (!normalizedPath || !normalizedPattern) return false;

  const pathParts = normalizedPath.split("/").filter(Boolean);
  const patternParts = normalizedPattern.split("/").filter(Boolean);
  if (!patternParts.length) return false;

  if (patternParts.length === 1) {
    return pathParts.includes(patternParts[0]);
  }

  for (let index = 0; index <= pathParts.length - patternParts.length; index++) {
    const window = pathParts.slice(index, index + patternParts.length);
    if (window.join("/") === patternParts.join("/")) {
      return true;
    }
  }
  return false;
}

module.exports = {
  compactErrorMessage,
  envFlag,
  matchesSyncPolicyPattern,
  normalizeEnvString,
  normalizePrefix,
  normalizeRelativeWorkspacePath,
  parseSyncPolicyExclude,
  pathExists,
  positiveNumber,
  readJsonFile,
  safePathInRoot,
  safeReadDir,
};
