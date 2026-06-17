import {SessionDetail} from "../sessions/SessionDetail.jsx";
import {SessionList} from "../sessions/SessionList.jsx";
import {WorkspaceHeader} from "./WorkspaceHeader.jsx";

export function WorkspacePanel({
  selectedSession,
  selectedWorkspace,
  state,
  onGetSessionAccessUrls,
  onCommitGit,
  onOpenPiAuthManage,
  onOpenPullRequest,
  onPullGit,
  onPushGit,
  onResizeSession,
  onRestartSession,
  onSelectSession,
  onStageGitPath,
  onUnstageGitPath,
  onUpdateGitCommitMessage,
}) {
  const isGithubWorkspace = selectedWorkspace?.source?.type === "github" || selectedSession?.sourceType === "github";

  if (selectedSession) {
    return (
      <section className="workspace">
        <SessionDetail
          busy={state.busy}
          gitStatus={state.gitStatus}
          isGithubWorkspace={isGithubWorkspace}
          session={selectedSession}
          workspaceId={state.selectedWorkspaceId}
          onCommitGit={onCommitGit}
          onGetSessionAccessUrls={onGetSessionAccessUrls}
          onOpenPiAuthManage={onOpenPiAuthManage}
          onOpenPullRequest={onOpenPullRequest}
          onPullGit={onPullGit}
          onPushGit={onPushGit}
          onResizeSession={onResizeSession}
          onRestartSession={onRestartSession}
          onStageGitPath={onStageGitPath}
          onUnstageGitPath={onUnstageGitPath}
          onUpdateGitCommitMessage={onUpdateGitCommitMessage}
        />
      </section>
    );
  }

  return (
    <section className="workspace">
      <WorkspaceHeader workspace={selectedWorkspace} />
      {state.error ? <div className="error">{state.error}</div> : null}
      <SessionList
        selectedSessionId={state.selectedSessionId}
        selectedWorkspaceId={state.selectedWorkspaceId}
        sessions={state.sessions}
        onSelectSession={onSelectSession}
      />
    </section>
  );
}
