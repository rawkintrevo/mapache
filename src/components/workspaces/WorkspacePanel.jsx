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
  onShareSessionPreview,
  onCloseSshSessionForward,
  onCreateSshSessionForward,
  onSelectSession,
  onStageGitPath,
  onUnstageGitPath,
  onUpdateGitCommitMessage,
  onUpdateSshForwardPort,
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
          sshForwards={state.sshForwards}
          workspaceId={state.selectedWorkspaceId}
          onCommitGit={onCommitGit}
          onGetSessionAccessUrls={onGetSessionAccessUrls}
          onOpenPiAuthManage={onOpenPiAuthManage}
          onOpenPullRequest={onOpenPullRequest}
          onPullGit={onPullGit}
          onPushGit={onPushGit}
          onResizeSession={onResizeSession}
          onRestartSession={onRestartSession}
          onShareSessionPreview={onShareSessionPreview}
          onCloseSshSessionForward={onCloseSshSessionForward}
          onCreateSshSessionForward={onCreateSshSessionForward}
          onStageGitPath={onStageGitPath}
          onUnstageGitPath={onUnstageGitPath}
          onUpdateGitCommitMessage={onUpdateGitCommitMessage}
          onUpdateSshForwardPort={onUpdateSshForwardPort}
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
