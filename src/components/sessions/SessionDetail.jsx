import {RotateCcw} from "lucide-react";
import {useRef, useState} from "react";
import {Button} from "../common/Button.jsx";

const cpuOptions = ["1", "2", "4"];
const memoryOptions = ["1Gi", "2Gi", "4Gi", "8Gi"];

function formatMemory(value) {
  return value.replace("Gi", " GiB");
}

export function SessionDetail({busy, session, onResizeSession, onRestartSession}) {
  const formRef = useRef(null);
  const [activeCanvas, setActiveCanvas] = useState("terminal");
  const capabilities = session.capabilities || {};
  const hasPreview = Boolean(capabilities.preview && session.serviceUrl);
  const previewUrl = hasPreview ? `${session.serviceUrl.replace(/\/+$/, "")}/preview/` : "";

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
      {capabilities.preview ? (
        <div className="canvas-tabs" role="tablist" aria-label="Session canvases">
          <Button
            aria-selected={activeCanvas === "terminal"}
            role="tab"
            variant={activeCanvas === "terminal" ? "primary" : "secondary"}
            onClick={() => setActiveCanvas("terminal")}
          >
            Terminal
          </Button>
          <Button
            aria-selected={activeCanvas === "preview"}
            disabled={!session.serviceUrl}
            role="tab"
            variant={activeCanvas === "preview" ? "primary" : "secondary"}
            onClick={() => setActiveCanvas("preview")}
          >
            Preview
          </Button>
        </div>
      ) : null}
      <div className="canvas-shell">
        {activeCanvas === "preview" && capabilities.preview ? (
          hasPreview ? (
            <iframe
              sandbox="allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts"
              src={previewUrl}
              title={`Preview ${session.name}`}
            />
          ) : (
            <div className="terminal-placeholder">
              <p>
                Preview is waiting for the runner URL.
                <br />
                <code>{session.lastError || session.status}</code>
              </p>
            </div>
          )
        ) : session.serviceUrl ? (
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
          <Button disabled={busy} onClick={handleResize}>Resize</Button>
          <Button disabled={busy} variant="secondary" onClick={() => onRestartSession(session.id)}>
            <RotateCcw aria-hidden="true" />
            Restart
          </Button>
        </div>
      </form>
    </div>
  );
}
