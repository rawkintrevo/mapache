export function canOpenPullRequestForSession(session, gitStatus, sticky = false) {
  if (!session || session.sourceMode !== "connected" || !gitStatus || gitStatus.git === false) {
    return false;
  }
  const baseBranch = session.sourceResolvedBranch || session.sourceRequestedBranch || "";
  return Boolean(
      sticky ||
      Number(gitStatus.ahead || 0) > 0 ||
      (gitStatus.branch && baseBranch && gitStatus.branch !== baseBranch),
  );
}
