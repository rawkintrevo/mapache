import {SessionDetail} from "../sessions/SessionDetail.jsx";
import {SessionList} from "../sessions/SessionList.jsx";
import {WorkspaceHeader} from "./WorkspaceHeader.jsx";
import {hasPendingOperations} from "../../state/pendingOperations.js";

export function WorkspacePanel({
  selectedSession,
  selectedWorkspace,
  state,
  onGetSessionAccessUrls,
  onCommitGit,
  onOpenPiAuthManage,
  onOpenPiModels,
  onOpenPullRequest,
  onPullGit,
  onPushGit,
  onRetryProvisioningSession,
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
  const busy = hasPendingOperations(state.pendingOperations);

  if (selectedSession) {
    return (
      <section className="workspace">
        <SessionDetail
          busy={busy}
          gitStatus={state.gitStatus}
          isGithubWorkspace={isGithubWorkspace}
          session={selectedSession}
          sshForwards={state.sshForwards}
          workspaceId={state.selectedWorkspaceId}
          onCommitGit={onCommitGit}
          onGetSessionAccessUrls={onGetSessionAccessUrls}
          onOpenPiAuthManage={onOpenPiAuthManage}
          onOpenPiModels={onOpenPiModels}
          onOpenPullRequest={onOpenPullRequest}
          onPullGit={onPullGit}
          onPushGit={onPushGit}
          onRetryProvisioningSession={onRetryProvisioningSession}
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
