export function DrawerSessionList({state, onDeleteSession, onSelectSession, onStopSession}) {
  if (!state.selectedWorkspaceId) {
    return <p className="empty">Select a workspace to view sessions.</p>;
  }

  if (!state.sessions.length) {
    return <p className="empty">No sessions in this workspace.</p>;
  }

  return (
    <div className="list">
      {state.sessions.map((session) => (
        <div className={`row session-row ${session.id === state.selectedSessionId ? "active" : ""}`} key={session.id}>
          <button className="session-select" type="button" onClick={() => onSelectSession(session.id)}>
            <span className="session-title">
              <span>{session.name}</span>
              <span className="pill">{session.status}</span>
            </span>
            <span className="subtle">{session.resources.cpu} CPU / {session.resources.memory}</span>
          </button>
          <div className="session-row-actions">
            {session.status === "running" ? (
              <button
                aria-label={`Stop ${session.name}`}
                className="session-action-button secondary"
                disabled={state.busy}
                title={`Stop ${session.name}`}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onStopSession(session.id);
                }}
              >
                ■
              </button>
            ) : null}
            <button
              aria-label={`Delete ${session.name}`}
              className="session-action-button secondary danger"
              disabled={state.busy}
              title={`Delete ${session.name}`}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onDeleteSession(session.id);
              }}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
