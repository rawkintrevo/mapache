"use strict";

const path = require("node:path").posix;

// A target can pass through a captured directory symlink. Resolve against the
// capture, not just the live filesystem: excluded aliases must not pass validation.
function assertCapturedSymlinkTargets(files) {
  const entries = new Map(files.map((file) => [file.path, file]));
  const directories = new Set(["."]);
  for (const file of files) {
    let parent = path.dirname(file.path);
    while (parent !== ".") {
      directories.add(parent);
      parent = path.dirname(parent);
    }
  }
  function isCaptured(target, visited = new Set()) {
    const parts = path.normalize(target).split("/");
    for (let index = 0; index < parts.length; index++) {
      const prefix = parts.slice(0, index + 1).join("/");
      const entry = entries.get(prefix);
      if (entry?.kind === "symlink") {
        if (visited.has(prefix)) return false;
        const next = new Set(visited).add(prefix);
        return isCaptured(path.join(path.dirname(prefix), entry.target, ...parts.slice(index + 1)), next);
      }
      if (!directories.has(prefix) && !(index === parts.length - 1 && entry)) return false;
    }
    return true;
  }
  for (const file of files.filter((entry) => entry.kind === "symlink")) {
    if (!isCaptured(path.join(path.dirname(file.path), file.target))) {
      throw Object.assign(new Error(`Workspace symlink target is excluded or empty: ${file.path}`), {
        code: "checkpoint_unsafe_symlink",
      });
    }
  }
}

module.exports = {assertCapturedSymlinkTargets};
