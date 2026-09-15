import {useCallback} from "react";
import {BrowserCanvas} from "./BrowserCanvas.jsx";
import {PiWebUiCanvas} from "./PiWebUiCanvas.jsx";

export function ManagedAgentSurface({
  accessError,
  accessUrls,
  activeCanvas,
  capabilities,
  hasAgent,
  hasBrowser,
  onAccessRefreshNeeded,
  onSelectCanvas,
  session,
  unavailableMessage,
}) {
  const handleOpenChrome = useCallback(() => onSelectCanvas?.("chrome"), [onSelectCanvas]);

  return (
    <div className={`canvas-shell canvas-shell--managed-agent${unavailableMessage ? " canvas-shell--status" : ""}`}>
      {activeCanvas === "agent" ? (
        hasAgent ? (
          <div className="canvas-panel">
            <PiWebUiCanvas
              key={session.id}
              accessError={accessError}
              onAccessRefreshNeeded={onAccessRefreshNeeded}
              onOpenChrome={handleOpenChrome}
              sessionName={session.name}
              url={accessUrls.agentUrl}
            />
          </div>
        ) : (
          unavailableMessage ? (
            <div className="terminal-placeholder runtime-status-card" role="status">
              <strong>{unavailableMessage}</strong>
              <span>{unavailableMessage.includes("historical") ? "This runtime cannot be started." : "Press Play in the navigation bar to start the runtime."}</span>
            </div>
          ) : (
            <div className="terminal-placeholder"><p>Agent access is not ready.<br /><code>{accessError || session.lastError || session.status}</code></p></div>
          )
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
    </div>
  );
}
