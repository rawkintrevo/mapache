import "./GitDrawerSection.css";
import {ArrowDownToLine, ArrowUpFromLine, FolderGit2, Settings2} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {DrawerSection} from "./DrawerSection.jsx";

function isGithubWorkspace(workspace, session) {
  return workspace?.source?.type === "github" || session?.sourceType === "github";
}

export function GitDrawerSection({busy, state, onOpenGitManager, onPullGit, onPushGit, onToggleDrawerSection}) {
  const session = (state.sessions || []).find((item) => item.id === state.selectedSessionId);
  const workspace = (state.workspaces || []).find((item) => item.id === state.selectedWorkspaceId);
  if (!session?.serviceUrl || !isGithubWorkspace(workspace, session)) return null;
  const status = state.gitStatus || {};
  const data = status.data;
  const available = Boolean(data && data.git !== false && !status.loading);
  const branch = data?.branch || "Detached HEAD";

  return (
    <DrawerSection
      id="left-git"
      state={state}
      title="Git"
      actions={[
        <Button aria-label="Manage Git" disabled={busy || !data || data.git === false} icon={true} key="manage-git" size="compact" title="Manage Git" tooltip="Manage Git" variant="secondary" onClick={onOpenGitManager}>
          <Settings2 aria-hidden="true" />
        </Button>,
      ]}
      onToggleDrawerSection={onToggleDrawerSection}
    >
      <div className="git-drawer-summary">
        <div className="git-drawer-branch"><FolderGit2 aria-hidden="true" /><strong title={branch}>{branch}</strong></div>
        {status.error ? <p className="error">{status.error}</p> : null}
        {status.actionMessage ? <p className="subtle">{status.actionMessage}</p> : null}
        <div className="git-drawer-actions">
          <Button disabled={busy || status.loading || !onPullGit} size="compact" variant="secondary" onClick={onPullGit}>
            <ArrowDownToLine aria-hidden="true" /> Pull
          </Button>
          <Button disabled={busy || !available || !onPushGit} size="compact" variant="secondary" onClick={onPushGit}>
            <ArrowUpFromLine aria-hidden="true" /> Push
          </Button>
        </div>
      </div>
    </DrawerSection>
  );
}
