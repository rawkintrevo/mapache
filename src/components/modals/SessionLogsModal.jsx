import {useCallback, useEffect, useState} from "react";
import {RefreshCw, X} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";
import "./ModalStack.css";

export function SessionLogsModal({session, workspaceId, onClose, onLoadLogs}) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!workspaceId || !session?.id || typeof onLoadLogs !== "function") {
      setError("session_logs_unavailable");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await onLoadLogs(workspaceId, session.id);
      setLogs(Array.isArray(result?.logs) ? result.logs : []);
    } catch (loadError) {
      setError(loadError?.message || "session_logs_unavailable");
    } finally {
      setLoading(false);
    }
  }, [onLoadLogs, session?.id, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="session-logs-title" aria-modal="true" className="modal-panel session-logs-panel" role="dialog">
        <div className="modal-heading">
          <div>
            <h2 id="session-logs-title">Logs</h2>
            <span className="session-logs-panel__session">{session?.name || "Workspace runtime"}</span>
          </div>
          <div className="session-logs-panel__actions">
            <Button aria-label="Refresh logs" disabled={loading} icon tooltip="Refresh logs" variant="secondary" onClick={load}>
              <RefreshCw aria-hidden="true" />
            </Button>
            <Button aria-label="Close logs" icon tooltip="Close" variant="secondary" onClick={onClose}>
              <X aria-hidden="true" />
            </Button>
          </div>
        </div>
        {session?.lastError ? (
          <div className="session-logs-panel__runtime-error" role="status">
            <strong>Runtime error</strong>
            <code>{session.lastError}</code>
          </div>
        ) : null}
        {loading ? <p className="empty">Loading logs…</p> : null}
        {!loading && error ? <p className="empty">Could not load logs: <code>{error}</code></p> : null}
        {!loading && !error && !logs.length ? <p className="empty">No runtime logs are available yet.</p> : null}
        {!loading && !error && logs.length ? (
          <ol aria-label="Runtime log entries" className="session-logs-list">
            {logs.map((entry, index) => (
              <li className={`session-log-entry session-log-entry--${String(entry.severity || "default").toLowerCase()}`} key={entry.id || `${entry.timestamp}-${index}`}>
                <div className="session-log-entry__meta">
                  <time dateTime={entry.timestamp}>{formatLogTime(entry.timestamp)}</time>
                  <span>{entry.severity || "DEFAULT"}</span>
                </div>
                <pre>{entry.message}</pre>
              </li>
            ))}
          </ol>
        ) : null}
      </section>
    </ModalBackdrop>
  );
}

function formatLogTime(value) {
  const date = new Date(value || "");
  if (!Number.isFinite(date.getTime())) return "Unknown time";
  return date.toLocaleString(undefined, {dateStyle: "short", timeStyle: "medium"});
}
