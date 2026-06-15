import {SessionDetail} from "../sessions/SessionDetail.jsx";
import {SessionList} from "../sessions/SessionList.jsx";
import {WorkspaceHeader} from "./WorkspaceHeader.jsx";

export function WorkspacePanel({
  selectedSession,
  selectedWorkspace,
  state,
  onGetSessionAccessUrls,
  onResizeSession,
  onRestartSession,
  onSelectSession,
}) {
  if (selectedSession) {
    return (
      <section className="workspace">
        <SessionDetail
          busy={state.busy}
          session={selectedSession}
          workspaceId={state.selectedWorkspaceId}
          onGetSessionAccessUrls={onGetSessionAccessUrls}
          onResizeSession={onResizeSession}
          onRestartSession={onRestartSession}
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
