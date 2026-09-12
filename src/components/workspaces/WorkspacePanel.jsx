import {SessionDetail} from "../sessions/SessionDetail.jsx";
import {SessionList} from "../sessions/SessionList.jsx";
import {WorkspaceHeader} from "./WorkspaceHeader.jsx";
import {hasPendingOperations} from "../../state/pendingOperations.js";
import {WorkspaceGoalsPanel} from "../goals/WorkspaceGoalsPanel.jsx";
import {isMarkedRuntimeSession} from "../sessions/sessionPresentation.js";

export function WorkspacePanel({
  selectedSession,
  selectedWorkspace,
  state,
  onGetSessionAccessUrls,
  onOpenPiAuthManage,
  onOpenPiModels,
  onRetryProvisioningSession,
  onRestartSession,
  onStopSession,
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
          api={state.api}
          busy={busy}
          session={selectedSession}
          sshForwards={state.sshForwards}
          workspaceId={state.selectedWorkspaceId}
          workspaceSessions={state.sessions}
          onGetSessionAccessUrls={onGetSessionAccessUrls}
          onOpenPiAuthManage={onOpenPiAuthManage}
          onOpenPiModels={onOpenPiModels}
          onRetryProvisioningSession={onRetryProvisioningSession}
          onRestartSession={onRestartSession}
          onStopSession={onStopSession}
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
      {selectedWorkspace?.agentUiVersion === "pi-web-ui-v1" || isMarkedRuntimeSession(selectedSession) ? null : (
        <WorkspaceGoalsPanel api={state.api} sessions={state.sessions} workspaceId={state.selectedWorkspaceId} />
      )}
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
