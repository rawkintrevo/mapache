import {SessionDetail} from "../sessions/SessionDetail.jsx";
import {SessionList} from "../sessions/SessionList.jsx";
import {WorkspaceHeader} from "./WorkspaceHeader.jsx";
import {hasPendingOperations} from "../../state/pendingOperations.js";

export function WorkspacePanel({
  selectedSession,
  selectedWorkspace,
  state,
  onGetSessionAccessUrls,
  onOpenPiAuthManage,
  onOpenPiModels,
  onRetryProvisioningSession,
  onRestartSession,
  onShareSessionPreview,
  onCloseSshSessionForward,
  onCreateSshSessionForward,
  onSelectSession,
  onUpdateSshForwardPort,
}) {
  const busy = hasPendingOperations(state.pendingOperations);

  if (selectedSession) {
    return (
      <section className="workspace">
        <SessionDetail
          busy={busy}
          session={selectedSession}
          sshForwards={state.sshForwards}
          workspaceId={state.selectedWorkspaceId}
          onGetSessionAccessUrls={onGetSessionAccessUrls}
          onOpenPiAuthManage={onOpenPiAuthManage}
          onOpenPiModels={onOpenPiModels}
          onRetryProvisioningSession={onRetryProvisioningSession}
          onRestartSession={onRestartSession}
          onShareSessionPreview={onShareSessionPreview}
          onCloseSshSessionForward={onCloseSshSessionForward}
          onCreateSshSessionForward={onCreateSshSessionForward}
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

export function resolveIsGithubWorkspace(workspace, session) {
  const workspaceSourceType = workspace?.source?.type;
  if (workspaceSourceType) return workspaceSourceType === "github";
  return session?.sourceType === "github";
}
