import "./SessionDetail.css";
import {useEffect, useState} from "react";
import {Button} from "../common/Button.jsx";
import {BrowserCanvas} from "./BrowserCanvas.jsx";
import {PiWebUiCanvas} from "./PiWebUiCanvas.jsx";
import {SessionRuntimeStatus} from "./SessionRuntimeStatus.jsx";
import {ManagedAgentSurface} from "./ManagedAgentSurface.jsx";
import {getSessionImageFreshness, isMarkedRuntimeSession, isSessionResizePending} from "./sessionPresentation.js";
import {normalizeSessionImageKey} from "../../config/sessionImages.js";
import {deriveShellUrl} from "../../utils/shell.js";

export function SessionDetail({
  activeCanvas: controlledActiveCanvas,
  session,
  workspaceId,
  access,
  onSelectCanvas,
}) {
  const [localActiveCanvas, setLocalActiveCanvas] = useState(() => (
    isMarkedRuntimeSession(session) ? "agent" : "terminal"
  ));
  const [showShell, setShowShell] = useState(false);
  const isManagedAgentSurface = isMarkedRuntimeSession(session);
  const activeCanvas = typeof controlledActiveCanvas === "string" ? controlledActiveCanvas : localActiveCanvas;
  const setActiveCanvas = onSelectCanvas || setLocalActiveCanvas;
  const capabilities = session.capabilities || {};
  const hasRunnerUrl = Boolean(session.serviceUrl);
  const accessUrls = access?.accessUrls || null;
  const accessError = access?.error || "";
  const refreshAfterConnectionFailure = access?.refreshAfterConnectionFailure;
  const refreshAccess = access?.refresh;
  const hasTerminal = Boolean(hasRunnerUrl && accessUrls?.terminalUrl);
  const hasBrowser = Boolean(capabilities.chrome && hasRunnerUrl && accessUrls?.browserUrl);
  const hasAgent = Boolean(hasRunnerUrl && accessUrls?.agentUrl);
  const shellUrl = deriveShellUrl(accessUrls?.terminalUrl);
  const hasShell = Boolean(hasRunnerUrl && session.status === "running" && shellUrl);
  const isProvisioning = session.status === "provisioning";
  const isProvisioningFailure = session.status === "provision_failed";
  const imageFreshness = getSessionImageFreshness(session);
  const isHistoricalRuntime = !hasRunnerUrl && (
    session.sourceType === "ssh" ||
    (Boolean(session.imageKey || session.image) && normalizeSessionImageKey(session) !== "pi-chrome")
  );
  const unavailableMessage = isHistoricalRuntime ? "This historical runtime is unavailable" :
    (!hasRunnerUrl && ["stopped", "inactive", "needs_image"].includes(String(session.status).toLowerCase()) ? "Workspace is stopped" : "");
  const isInactiveRuntime = Boolean(unavailableMessage);

  useEffect(() => {
    setActiveCanvas(isManagedAgentSurface ? "agent" : "terminal");
  }, [workspaceId, session.id, isManagedAgentSurface, setActiveCanvas]);

  useEffect(() => {
    setShowShell(false);
  }, [workspaceId, session.id]);

  return (
    <div className="session-detail">
      {isManagedAgentSurface && isSessionResizePending(session) ? (
        <div className="session-runtime-status" role="status">Resizing runtime… Shutdown and startup can take a few minutes.</div>
      ) : null}
      {isManagedAgentSurface && session.resizeOperationState === "failed" ? (
        <div className="error" role="alert">Runtime resize failed: {session.resizeOperationError || "Please try again."}</div>
      ) : null}
      {!isManagedAgentSurface ? (
        <SessionRuntimeStatus
          accessError={accessError}
          onRetryAccess={refreshAccess}
          session={session}
        />
      ) : null}
      {!isManagedAgentSurface ? <div className="canvas-header">
        {(hasAgent || capabilities.chrome) ? (
          <div className="canvas-tabs" role="tablist" aria-label="Session canvases">
          <Button
            aria-selected={activeCanvas === "terminal"}
            role="tab"
            variant={activeCanvas === "terminal" ? "primary" : "secondary"}
            onClick={() => setActiveCanvas("terminal")}
          >
            Terminal
          </Button>
          {hasAgent ? (
            <Button
              aria-selected={activeCanvas === "agent"}
              role="tab"
              variant={activeCanvas === "agent" ? "primary" : "secondary"}
              onClick={() => setActiveCanvas("agent")}
            >
              Agent
            </Button>
          ) : null}
          {capabilities.chrome ? (
            <Button
              aria-selected={activeCanvas === "chrome"}
              disabled={!hasRunnerUrl}
              role="tab"
              variant={activeCanvas === "chrome" ? "primary" : "secondary"}
              onClick={() => setActiveCanvas("chrome")}
            >
              Chrome
            </Button>
          ) : null}
          </div>
        ) : null}
      </div> : null}
      {!isManagedAgentSurface && isProvisioning ? (
        <div aria-live="polite" className="provisioning-status">
          <strong>{session.provisioningState === "queued" ? "Queued for provisioning" : "Provisioning in progress"}</strong>
          <span>The session will become available when its runner is ready.</span>
        </div>
      ) : null}
      {!isManagedAgentSurface && isProvisioningFailure ? (
        <div aria-live="polite" className="provisioning-status provisioning-status--failure">
          <strong>Provisioning failed</strong>
          <span>Use Play in the navigation bar to restart the workspace runtime.</span>
        </div>
      ) : null}
      {!isManagedAgentSurface && imageFreshness.state !== "unknown" ? (
        <div className={`image-freshness-status image-freshness-status--${imageFreshness.tone}`} role="status">
          <strong>{imageFreshness.label}</strong>
          <span>{imageFreshness.message}</span>
        </div>
      ) : null}
      {isManagedAgentSurface ? (
        <ManagedAgentSurface
          accessError={accessError}
          accessUrls={accessUrls}
          activeCanvas={activeCanvas}
          capabilities={capabilities}
          hasAgent={hasAgent}
          hasBrowser={hasBrowser}
          onAccessRefreshNeeded={refreshAfterConnectionFailure}
          onSelectCanvas={setActiveCanvas}
          session={session}
          unavailableMessage={unavailableMessage}
        />
      ) : <>
      {isInactiveRuntime ? (
        <div className="canvas-shell runtime-status-shell">
          <div className="terminal-placeholder runtime-status-card" role="status">
            <strong>{unavailableMessage}</strong>
            <span>{isHistoricalRuntime ? "This runtime cannot be started." : "Press Play in the navigation bar to start the runtime."}</span>
          </div>
        </div>
      ) : <div className="canvas-shell">
        {hasTerminal ? (
          <div className="canvas-panel" hidden={activeCanvas !== "terminal"}>
            <iframe
              allow="clipboard-read; clipboard-write"
              src={accessUrls.terminalUrl}
              title={`Terminal ${session.name}`}
            />
          </div>
        ) : activeCanvas === "terminal" ? (
          <div className="terminal-placeholder">
            <p>
              Terminal access is not ready.
              <br />
              <code>{accessError || session.lastError || session.status}</code>
            </p>
          </div>
        ) : null}
        {hasAgent ? (
          <div className="canvas-panel" hidden={activeCanvas !== "agent"}>
            <PiWebUiCanvas
              key={session.id}
              accessError={accessError}
              onAccessRefreshNeeded={refreshAfterConnectionFailure}
              sessionName={session.name}
              url={accessUrls.agentUrl}
            />
          </div>
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
      </div>}
      <div className="toolbar">
        <div className="session-actions">
          <Button
            aria-expanded={showShell}
            aria-controls="session-shell-panel"
            disabled={!hasShell}
            variant={showShell ? "primary" : "secondary"}
            onClick={() => setShowShell((current) => !current)}
          >
            Shell
          </Button>
        </div>
      </div>
      {showShell && shellUrl ? (
        <div className="shell-panel" id="session-shell-panel">
          <iframe
            allow="clipboard-read; clipboard-write"
            src={shellUrl}
            title={`Shell ${session.name}`}
          />
        </div>
      ) : null}
      </>}
    </div>
  );
}
