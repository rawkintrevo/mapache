import "../sessions/GitStatusPanel.css";
import "./GitManagerModal.css";
import {GitBranch, GitCommitHorizontal, GitPullRequest, Minus, Plus, RefreshCw, X} from "lucide-react";
import {useEffect, useMemo, useState} from "react";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

function FileGroup({title, files, busy, action, actionLabel, onAction, secondaryAction, secondaryLabel, onSecondaryAction}) {
  return (
    <section className="git-manager-group">
      <div className="git-manager-group-heading"><h3>{title}</h3><span className="pill">{files.length}</span></div>
      {files.length ? files.map((file) => (
        <div className="git-file-row" key={`${title}-${file.path}`}>
          <div className="git-file-meta"><strong>{file.path}</strong><span className="subtle">{file.conflicted ? "conflicted" : "changed"}</span></div>
          <div className="git-file-actions">
            {action ? <Button disabled={busy} size="compact" variant="secondary" onClick={() => onAction(file.path)}>{action === "stage" ? <Plus aria-hidden="true" /> : <Minus aria-hidden="true" />}{actionLabel}</Button> : null}
            {secondaryAction ? <Button disabled={busy} size="compact" variant="secondary" onClick={() => onSecondaryAction(file.path)}>{secondaryAction === "ignore" ? <X aria-hidden="true" /> : null}{secondaryLabel}</Button> : null}
          </div>
        </div>
      )) : <p className="subtle">No files.</p>}
    </section>
  );
}

export function GitManagerModal({busy, gitStatus, session, onCheckoutBranch, onClose, onCommitGit, onCreateBranch, onIgnoreGitPath, onOpenPullRequest, onRefreshBranches, onStageGitPath, onUnstageGitPath, onUpdateGitCommitMessage}) {
  const status = gitStatus || {};
  const data = status.data;
  const [newBranch, setNewBranch] = useState("");
  useEffect(() => setNewBranch(""), [session?.id, data?.branch]);
  const files = data?.files || [];
  const staged = useMemo(() => files.filter((file) => file.staged), [files]);
  const unstaged = useMemo(() => files.filter((file) => file.unstaged && !file.untracked), [files]);
  const untracked = useMemo(() => files.filter((file) => file.untracked), [files]);
  const canCommit = Boolean(!busy && status.commitMessage?.trim() && data?.dirty?.staged);

  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="git-manager-modal-title" aria-modal="true" className="modal-panel git-manager-panel" role="dialog">
        <div className="modal-heading"><h2 id="git-manager-modal-title">Git</h2><Button aria-label="Close Git dialog" icon={true} tooltip="Close Git dialog" variant="secondary" onClick={onClose}><X aria-hidden="true" /></Button></div>
        {status.error ? <div className="error">{status.error}</div> : null}
        {status.branchActionMessage ? <p className="subtle">{status.branchActionMessage}</p> : null}
        <div className="git-manager-branch-controls">
          <label><span>Current branch</span><select disabled={busy || status.branchesLoading} value={data?.branch || ""} onChange={(event) => onCheckoutBranch(event.target.value)}><option value="">{data?.branch ? "Choose branch" : "Detached HEAD"}</option>{(status.branches || []).map((branch) => <option key={branch.name} value={branch.name}>{branch.name}{branch.local && branch.remote ? "" : branch.remote ? " (remote)" : " (local)"}</option>)}</select></label>
          <Button disabled={busy || status.branchesLoading} size="compact" variant="secondary" onClick={onRefreshBranches}><RefreshCw aria-hidden="true" /> Refresh</Button>
        </div>
        <form className="git-manager-new-branch" onSubmit={(event) => { event.preventDefault(); if (newBranch.trim()) { onCreateBranch(newBranch.trim()); setNewBranch(""); } }}><label><span>Create branch</span><input autoComplete="off" placeholder="feature/my-change" value={newBranch} onChange={(event) => setNewBranch(event.target.value)} /></label><Button disabled={busy || !newBranch.trim()} type="submit"><GitBranch aria-hidden="true" /> Create</Button></form>
        <div className="details git-status-details"><div className="metric"><span>Commit</span><strong>{data?.commit ? data.commit.slice(0, 12) : "-"}</strong></div><div className="metric"><span>Ahead / Behind</span><strong>{data ? `${data.ahead ?? "-"} / ${data.behind ?? "-"}` : "-"}</strong></div><div className="metric"><span>Conflicts</span><strong>{data?.conflicted ? "Yes" : "No"}</strong></div></div>
        {data?.git === false ? <p className="empty">Git is unavailable for this session.</p> : status.loading ? <p className="empty">Loading Git status...</p> : <div className="git-manager-files"><FileGroup busy={busy} files={staged} action="unstage" actionLabel="Unstage" onAction={onUnstageGitPath} title="Staged files" /><FileGroup busy={busy} files={unstaged} action="stage" actionLabel="Stage" onAction={onStageGitPath} title="Unstaged files" /><FileGroup busy={busy} files={untracked} action="stage" actionLabel="Stage" onAction={onStageGitPath} secondaryAction="ignore" secondaryLabel="Ignore" onSecondaryAction={onIgnoreGitPath} title="Untracked files" /></div>}
        <form className="git-commit-form" onSubmit={(event) => { event.preventDefault(); if (canCommit) onCommitGit(); }}><input autoComplete="off" disabled={busy || status.loading} placeholder="Commit message" value={status.commitMessage || ""} onChange={(event) => onUpdateGitCommitMessage(event.target.value)} /><Button disabled={!canCommit} type="submit"><GitCommitHorizontal aria-hidden="true" /> Commit</Button></form>
        <div className="toolbar"><div /> <div className="session-actions"><Button disabled={busy || !status.canOpenPr} variant="secondary" onClick={onOpenPullRequest}><GitPullRequest aria-hidden="true" /> Open PR</Button><Button disabled={busy} variant="secondary" onClick={onClose}>Done</Button></div></div>
      </section>
    </ModalBackdrop>
  );
}
