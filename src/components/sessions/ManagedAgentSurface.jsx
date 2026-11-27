import {PiWebUiCanvas} from "./PiWebUiCanvas.jsx";

export function ManagedAgentSurface({
  accessError,
  accessUrls,
  activeCanvas,
  children,
  hasAgent,
  onAccessRefreshNeeded,
  onOpenChrome,
  session,
  unavailableMessage,
}) {
  return (
    <div className={`canvas-shell canvas-shell--managed-agent${unavailableMessage ? " canvas-shell--status" : ""}`}>
      {activeCanvas === "agent" ? (
        hasAgent ? (
          <div className="canvas-panel">
            <PiWebUiCanvas
              key={session.id}
              accessError={accessError}
              onAccessRefreshNeeded={onAccessRefreshNeeded}
              onOpenChrome={onOpenChrome}
              sessionName={session.name}
              url={accessUrls.agentUrl}
              healthUrl={accessUrls.healthUrl}
            />
          </div>
        ) : (
          unavailableMessage ? (
            <div className="terminal-placeholder runtime-status-card" role="status">
              <strong>{unavailableMessage}</strong>
              <span>{unavailableMessage.includes("historical") ? "This runtime cannot be started." : "Open Workspace power controls and choose Start workspace."}</span>
            </div>
          ) : (
            <div className="terminal-placeholder"><p>Agent access is not ready.<br /><code>{accessError || session.lastError || session.status}</code></p></div>
          )
        )
      ) : null}
      {children}
    </div>
  );
}
