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
  session,
}) {
  return (
    <div className="canvas-shell canvas-shell--managed-agent">
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
    </div>
  );
}
