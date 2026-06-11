export function workspaceSourceSummary(workspace) {
  if (!workspace) return "";
  const source = workspace.source || {type: "blank"};
  if (source.type !== "github") {
    return workspace.storagePrefix || "";
  }

  const repo = [source.owner, source.repo].filter(Boolean).join("/") || "GitHub repo";
  const branch = source.resolvedBranch || source.requestedBranch || "main";
  const sha = (source.resolvedCommit || source.requestedCommit || "").slice(0, 7);
  return [repo, branch, sha || null].filter(Boolean).join(" · ");
}
