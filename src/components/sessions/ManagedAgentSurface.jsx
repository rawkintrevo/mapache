import {RotateCcw, Square} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {BrowserCanvas} from "./BrowserCanvas.jsx";
import {PiWebUiCanvas} from "./PiWebUiCanvas.jsx";

export function ManagedAgentSurface({
  accessError,
  accessUrls,
  activeCanvas,
  busy,
  capabilities,
  hasAgent,
  hasBrowser,
  hasPreview,
  hasRunnerUrl,
  isRestartBlocked,
  isRetryableFailure,
  isStaleImage,
  metrics,
  onAccessRefreshNeeded,
  onRestartSession,
  onRetryProvisioningSession,
  onStopSession,
  session,
  setActiveCanvas,
}) {
  const startLabel = session.status === "stopped" ? "Start" : "Restart";
  const canStop = session.status === "running" && !isRestartBlocked && typeof onStopSession === "function";

  return (
    <>
      <div className="canvas-header">
        <div className="canvas-tabs" role="tablist" aria-label="Workspace surfaces">
          <Button
            aria-selected={activeCanvas === "agent"}
            role="tab"
            variant={activeCanvas === "agent" ? "primary" : "secondary"}
            onClick={() => setActiveCanvas("agent")}
          >
            Agent
          </Button>
          {capabilities.chrome ? (
            <Button
              aria-selected={activeCanvas === "chrome"}
              disabled={!hasRunnerUrl}
              role="tab"
              variant={activeCanvas === "chrome" ? "primary" : "secondary"}
              onClick={() => setActiveCanvas("chrome")}
            >
              Persistent Chrome
            </Button>
          ) : null}
          {capabilities.preview ? (
            <Button
              aria-selected={activeCanvas === "preview"}
              disabled={!hasRunnerUrl}
              role="tab"
              variant={activeCanvas === "preview" ? "primary" : "secondary"}
              onClick={() => setActiveCanvas("preview")}
            >
              Preview
            </Button>
          ) : null}
        </div>
        {metrics}
      </div>
      <div className="canvas-shell">
        {activeCanvas === "agent" ? (
          hasAgent ? (
            <div className="canvas-panel">
              <PiWebUiCanvas
                key={session.id}
                accessError={accessError}
                onAccessRefreshNeeded={onAccessRefreshNeeded}
                sessionName={session.name}
                url={accessUrls.agentUrl}
              />
            </div>
          ) : (
            <div className="terminal-placeholder">
              <p>
                Agent access is not ready.
                <br />
                <code>{accessError || session.lastError || session.status}</code>
              </p>
            </div>
          )
        ) : null}
        {activeCanvas === "chrome" && capabilities.chrome ? (
          hasBrowser ? (
            <BrowserCanvas sessionName={session.name} url={accessUrls.browserUrl} />
          ) : (
            <div className="terminal-placeholder">
              <p>
                Chrome access is not ready.
                <br />
                <code>{accessError || session.lastError || session.status}</code>
              </p>
            </div>
          )
        ) : null}
        {activeCanvas === "preview" && capabilities.preview ? (
          hasPreview ? (
            <iframe
              allow="clipboard-read; clipboard-write; screen-wake-lock"
              sandbox="allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts"
              src={accessUrls.previewUrl}
              title={`Preview ${session.name}`}
            />
          ) : (
            <div className="terminal-placeholder">
              <p>
                Preview access is not ready.
                <br />
                <code>{accessError || session.lastError || session.status}</code>
              </p>
            </div>
          )
        ) : null}
      </div>
      <div className="toolbar workspace-runner-lifecycle">
        <div className="session-actions">
          {canStop ? (
            <Button disabled={busy} variant="secondary" onClick={() => onStopSession(session.id)}>
              <Square aria-hidden="true" />
              Stop
            </Button>
          ) : null}
          {isRetryableFailure ? (
            <Button
              disabled={busy}
              title="Retry provisioning"
              variant="secondary"
              onClick={() => onRetryProvisioningSession?.(session.id)}
            >
              <RotateCcw aria-hidden="true" />
              Retry provisioning
            </Button>
          ) : session.status === "provisioning" ? null : (
            <Button
              aria-label={isStaleImage ? "Restart session to pick up the latest container image" : startLabel}
              className={isStaleImage ? "session-restart-button--stale" : ""}
              disabled={busy || isRestartBlocked}
              title={isRestartBlocked ? "Restart is disabled until the server confirms the stop outcome" : isStaleImage ? "Restart to pick up the latest container image" : startLabel}
              variant="secondary"
              onClick={() => onRestartSession(session.id)}
            >
              <RotateCcw aria-hidden="true" />
              {startLabel}
            </Button>
          )}
        </div>
        <span className="subtle workspace-runner-lifecycle__hint">Edit the session to change its resource size.</span>
      </div>
    </>
  );
}
