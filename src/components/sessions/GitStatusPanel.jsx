import "./GitStatusPanel.css";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  GitCommitHorizontal,
  GitPullRequest,
  Minus,
  Plus,
} from "lucide-react";
import {Button} from "../common/Button.jsx";

function formatGitCount(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return String(value);
}

function formatGitDirtySummary(dirty) {
  if (!dirty) return "-";
  const parts = [];
  if (dirty.staged) parts.push(`${dirty.staged} staged`);
  if (dirty.modified) parts.push(`${dirty.modified} modified`);
  if (dirty.deleted) parts.push(`${dirty.deleted} deleted`);
  if (dirty.untracked) parts.push(`${dirty.untracked} untracked`);
  if (dirty.conflicted) parts.push(`${dirty.conflicted} conflicted`);
  return parts.length ? parts.join(", ") : "Clean";
}

function formatGitFileStatus(file) {
  if (!file) return "";
  const parts = [];
  if (file.conflicted) parts.push("conflicted");
  if (file.untracked) parts.push("untracked");
  if (file.staged) parts.push("staged");
  if (file.unstaged) parts.push("unstaged");
  return parts.join(" - ") || "changed";
}

function Metric({label, value}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value || "pending"}</strong>
    </div>
  );
}

function GitFileList({busy, files, onStageGitPath, onUnstageGitPath}) {
  if (!files.length) {
    return <p className="subtle">No changed files.</p>;
  }

  return (
    <div className="git-file-list">
      {files.map((file) => {
        const path = file.path || "";
        return (
          <div className="git-file-row" key={path}>
            <div className="git-file-meta">
              <strong>{path}</strong>
              <span className="subtle">{formatGitFileStatus(file)}</span>
            </div>
            <div className="git-file-actions">
              {file.unstaged || file.untracked || file.conflicted ? (
                <Button
                  disabled={busy || !onStageGitPath}
                  variant="secondary"
                  onClick={() => onStageGitPath?.(path)}
                >
                  <Plus aria-hidden="true" />
                  Stage
                </Button>
              ) : null}
              {file.staged ? (
                <Button
                  disabled={busy || !onUnstageGitPath}
                  variant="secondary"
                  onClick={() => onUnstageGitPath?.(path)}
                >
                  <Minus aria-hidden="true" />
                  Unstage
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GitStatusBody({status, handlers}) {
  const data = status.data;
  if (status.loading) {
    return <p className="empty">Loading Git status...</p>;
  }
  if (status.error) {
    return <p className="empty">{status.error}</p>;
  }
  if (status.unavailable || !data || data.git === false) {
    return <p className="empty">{data?.reason || "Git status is unavailable."}</p>;
  }

  return (
    <div className="git-status-body">
      <div className="details git-status-details">
        <Metric label="Branch" value={data.branch || "detached"} />
        <Metric label="Commit" value={data.commit ? data.commit.slice(0, 7) : ""} />
        <Metric label="Ahead / Behind" value={`${formatGitCount(data.ahead)} / ${formatGitCount(data.behind)}`} />
        <Metric label="Working tree" value={formatGitDirtySummary(data.dirty)} />
        <Metric label="Conflicts" value={data.conflicted ? "Yes" : "No"} />
      </div>
      <GitFileList
        busy={status.loading}
        files={data.files || []}
        onStageGitPath={handlers.onStageGitPath}
        onUnstageGitPath={handlers.onUnstageGitPath}
      />
    </div>
  );
}

function GitStatusHelp({session}) {
  const isConnectedPiGithubSession = session?.sourceType === "github" &&
    session?.sourceMode === "connected" &&
    session?.terminalKind === "pi";

  return (
    <>
      <p className="subtle">Push sends the current branch only. Stage files and create a commit before pushing.</p>
      {isConnectedPiGithubSession ? (
        <p className="subtle">Connected Pi sessions still handle the automation branch push and PR flow when the Pi process exits.</p>
      ) : null}
    </>
  );
}

export function GitStatusPanel({
  busy,
  gitStatus,
  session,
  onCommitGit,
  onOpenPullRequest,
  onPullGit,
  onPushGit,
  onStageGitPath,
  onUnstageGitPath,
  onUpdateGitCommitMessage,
}) {
  const status = gitStatus || {loading: false, error: "", unavailable: false, data: null, commitMessage: ""};
  const data = status.data;
  const canCommit = Boolean(
      !busy &&
      !status.loading &&
      onCommitGit &&
      data &&
      data.git !== false &&
      status.commitMessage &&
      status.commitMessage.trim() &&
      data.dirty &&
      data.dirty.staged,
  );
  const canPush = Boolean(!busy && !status.loading && onPushGit && data && data.git !== false);
  const canOpenPr = Boolean(!busy && !status.loading && onOpenPullRequest && status.canOpenPr);

  return (
    <section className="git-status-panel" aria-label="Git status">
      <div className="drawer-section-heading">
        <h3>{session?.name ? `Git status - ${session.name}` : "Git status"}</h3>
        <div className="git-status-actions">
          <span className="pill">{data && data.git ? "Git" : status.unavailable ? "Unavailable" : "Loading"}</span>
          <Button
            disabled={busy || status.loading || !onPullGit}
            variant="secondary"
            onClick={onPullGit}
          >
            <ArrowDownToLine aria-hidden="true" />
            Pull
          </Button>
          <Button
            disabled={!canPush}
            variant="secondary"
            onClick={onPushGit}
          >
            <ArrowUpFromLine aria-hidden="true" />
            Push
          </Button>
          <Button
            disabled={!canOpenPr}
            variant="secondary"
            onClick={onOpenPullRequest}
          >
            <GitPullRequest aria-hidden="true" />
            Open PR
          </Button>
        </div>
      </div>
      {status.actionMessage ? <p className="subtle">{status.actionMessage}</p> : null}
      <GitStatusBody
        handlers={{onStageGitPath, onUnstageGitPath}}
        status={status}
      />
      <GitStatusHelp session={session} />
      {data && data.git ? (
        <form
          className="git-commit-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canCommit) onCommitGit?.();
          }}
        >
          <input
            autoComplete="off"
            disabled={busy || status.loading}
            placeholder="Commit message"
            type="text"
            value={status.commitMessage || ""}
            onChange={(event) => onUpdateGitCommitMessage?.(event.target.value)}
          />
          <Button disabled={!canCommit} type="submit">
            <GitCommitHorizontal aria-hidden="true" />
            Commit
          </Button>
        </form>
      ) : null}
    </section>
  );
}
