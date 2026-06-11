export function SessionList({selectedSessionId, selectedWorkspaceId, sessions, onSelectSession}) {
  if (!selectedWorkspaceId) return null;

  if (!sessions.length) {
    return (
      <div className="list">
        <p className="empty">No sessions in this workspace.</p>
      </div>
    );
  }

  return (
    <div className="list">
      {sessions.map((session) => (
        <button
          className={`row ${session.id === selectedSessionId ? "active" : ""}`}
          key={session.id}
          type="button"
          onClick={() => onSelectSession(session.id)}
        >
          <span className="session-title">
            <span>{session.name}</span>
            <span className="pill">{session.status}</span>
          </span>
          <span className="subtle">{session.resources.cpu} CPU / {session.resources.memory}</span>
        </button>
      ))}
    </div>
  );
}
