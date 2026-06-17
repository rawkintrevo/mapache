"use strict";

const {normalizeRelativeWorkspacePath} = require("./utils");

function parseGitPorcelainStatus(output) {
  const lines = String(output || "").split(/\r?\n/).filter(Boolean);
  let ahead = null;
  let behind = null;
  let staged = 0;
  let modified = 0;
  let deleted = 0;
  let untracked = 0;
  let conflicted = 0;
  const files = [];
  const conflictCodes = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const aheadMatch = line.match(/ahead (\d+)/);
      const behindMatch = line.match(/behind (\d+)/);
      ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
      behind = behindMatch ? Number(behindMatch[1]) : 0;
      continue;
    }
    if (line.startsWith("??")) {
      untracked += 1;
      files.push({
        path: parseGitStatusPath(line.slice(3)),
        x: "?",
        y: "?",
        staged: false,
        unstaged: true,
        untracked: true,
        conflicted: false,
      });
      continue;
    }
    const x = line[0] || " ";
    const y = line[1] || " ";
    const code = `${x}${y}`;
    const file = {
      path: parseGitStatusPath(line.slice(3)),
      x,
      y,
      staged: x !== " ",
      unstaged: y !== " ",
      untracked: false,
      conflicted: conflictCodes.has(code),
    };
    files.push(file);
    if (file.conflicted) {
      conflicted += 1;
      continue;
    }
    if (x !== " ") staged += 1;
    if (y === "M" || y === "T") modified += 1;
    if (x === "D" || y === "D") deleted += 1;
  }

  return {ahead, behind, staged, modified, deleted, untracked, conflicted, files};
}

function parseGitStatusPath(value) {
  const text = String(value || "").trim();
  const renameParts = text.split(" -> ");
  return normalizeRelativeWorkspacePath(renameParts[renameParts.length - 1] || text);
}

module.exports = {
  parseGitPorcelainStatus,
  parseGitStatusPath,
};
