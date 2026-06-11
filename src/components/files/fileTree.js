export function buildFileTree(files) {
  const root = {children: new Map(), files: [], name: "", path: ""};
  for (const entry of files) {
    const parts = String(entry.path || "").split("/").filter(Boolean);
    if (!parts.length) continue;
    let current = root;
    const folderParts = entry.type === "directory" ? parts : parts.slice(0, -1);
    folderParts.forEach((part) => {
      const path = current.path ? `${current.path}/${part}` : part;
      if (!current.children.has(part)) {
        current.children.set(part, {children: new Map(), files: [], name: part, path});
      }
      current = current.children.get(part);
    });
    if (entry.type !== "directory") {
      current.files.push(entry);
    }
  }
  return root;
}

export function countFolderFiles(folder) {
  return folder.files.length +
    Array.from(folder.children.values()).reduce((total, child) => total + countFolderFiles(child), 0);
}
