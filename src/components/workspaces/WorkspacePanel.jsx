import {SessionDetail} from "../sessions/SessionDetail.jsx";
import {isMarkedRuntimeSession} from "../sessions/sessionPresentation.js";
import {WorkspaceHeader} from "./WorkspaceHeader.jsx";

export function WorkspacePanel({
  activeCanvas,
  selectedSession,
  selectedWorkspace,
  state,
  access,
  onSelectCanvas,
}) {
  if (selectedSession) {
    return (
      <section className={`workspace${isMarkedRuntimeSession(selectedSession) ? " workspace--managed-agent" : ""}`}>
        <SessionDetail
          activeCanvas={activeCanvas}
          access={access}
          session={selectedSession}
          workspaceId={state.selectedWorkspaceId}
          onSelectCanvas={onSelectCanvas}
        />
      </section>
    );
  }

  return (
    <section className="workspace">
      <WorkspaceHeader workspace={selectedWorkspace} />
      {state.error ? <div className="error">{state.error}</div> : null}
      <div className="workspace-off-state" role="status">
        <strong>Workspace is off</strong>
        <span>Press Play in the navigation bar to start its runtime.</span>
      </div>
    </section>
  );
}

export function resolveIsGithubWorkspace(workspace, session) {
  const workspaceSourceType = workspace?.source?.type;
  if (workspaceSourceType) return workspaceSourceType === "github";
  return session?.sourceType === "github";
}
