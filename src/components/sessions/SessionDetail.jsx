import {useRef} from "react";

const cpuOptions = ["1", "2", "4"];
const memoryOptions = ["1Gi", "2Gi", "4Gi", "8Gi"];

function formatMemory(value) {
  return value.replace("Gi", " GiB");
}

export function SessionDetail({busy, session, onResizeSession, onRestartSession}) {
  const formRef = useRef(null);

  const handleResize = () => {
    const form = formRef.current;
    if (!form) return;
    const formData = new FormData(form);
    onResizeSession(session.id, {
      cpu: formData.get("resizeCpu"),
      memory: formData.get("resizeMemory"),
    });
  };

  return (
    <div className="session-detail">
      <div className="terminal-shell">
        {session.serviceUrl ? (
          <iframe
            allow="clipboard-read; clipboard-write"
            src={session.serviceUrl}
            title={`Terminal ${session.name}`}
          />
        ) : (
          <div className="terminal-placeholder">
            <p>
              Cloud Run URL is not ready.
              <br />
              <code>{session.lastError || session.status}</code>
            </p>
          </div>
        )}
      </div>
      <form className="toolbar" ref={formRef}>
        <label>
          <span>CPU</span>
          <select defaultValue={session.resources.cpu} name="resizeCpu">
            {cpuOptions.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label>
          <span>Memory</span>
          <select defaultValue={session.resources.memory} name="resizeMemory">
            {memoryOptions.map((value) => <option key={value} value={value}>{formatMemory(value)}</option>)}
          </select>
        </label>
        <div className="session-actions">
          <button disabled={busy} type="button" onClick={handleResize}>Resize</button>
          <button className="secondary" disabled={busy} type="button" onClick={() => onRestartSession(session.id)}>
            Restart
          </button>
        </div>
      </form>
    </div>
  );
}
