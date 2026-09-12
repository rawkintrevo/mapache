import "./SessionDetail.css";
import {RotateCcw} from "lucide-react";
import {useEffect, useState} from "react";
import {Button} from "../common/Button.jsx";
import {BrowserCanvas} from "./BrowserCanvas.jsx";
import {PiWebUiCanvas} from "./PiWebUiCanvas.jsx";
import {ResourceUtilization} from "./ResourceUtilization.jsx";
import {SessionRuntimeStatus} from "./SessionRuntimeStatus.jsx";
import {ManagedAgentSurface} from "./ManagedAgentSurface.jsx";
import {getSessionImageFreshness, isMarkedRuntimeSession, isRetryableProvisioningFailure, isRuntimeStopUncertain} from "./sessionPresentation.js";
import {deriveResourceMetricsSocketUrl} from "../../utils/resourceMetrics.js";
import {deriveShellUrl} from "../../utils/shell.js";
import {useResourceMetrics} from "./useResourceMetrics.js";
import {useSessionAccessUrls} from "./useSessionAccessUrls.js";

export function SessionDetail({
  busy,
  session,
  workspaceId,
  onGetSessionAccessUrls,
  onRetryProvisioningSession,
  onRestartSession,
  onStopSession,
}) {
  const [activeCanvas, setActiveCanvas] = useState("terminal");
  const [showShell, setShowShell] = useState(false);
  const isManagedAgentSurface = isMarkedRuntimeSession(session);
  const capabilities = session.capabilities || {};
  const hasRunnerUrl = Boolean(session.serviceUrl);
  const {
    accessUrls,
    error: accessError,
    refreshAfterConnectionFailure,
    refresh: refreshAccess,
  } = useSessionAccessUrls({
    enabled: hasRunnerUrl,
    workspaceId,
    sessionId: session.id,
    serviceUrl: session.serviceUrl || "",
    loadAccessUrls: onGetSessionAccessUrls,
  });
  const hasTerminal = Boolean(hasRunnerUrl && accessUrls?.terminalUrl);
  const hasPreview = Boolean(capabilities.preview && hasRunnerUrl && accessUrls?.previewUrl);
  const hasBrowser = Boolean(capabilities.chrome && hasRunnerUrl && accessUrls?.browserUrl);
  const hasAgent = Boolean(hasRunnerUrl && accessUrls?.agentUrl);
  const metricsSocketUrl = deriveResourceMetricsSocketUrl(accessUrls?.terminalUrl);
  const shellUrl = deriveShellUrl(accessUrls?.terminalUrl);
  const hasShell = Boolean(hasRunnerUrl && session.status === "running" && shellUrl);
  const isProvisioning = session.status === "provisioning";
  const isProvisioningFailure = session.status === "provision_failed";
  const isRetryableFailure = isRetryableProvisioningFailure(session);
  const isRestartBlocked = isRuntimeStopUncertain(session);
  const imageFreshness = getSessionImageFreshness(session);
  const isStaleImage = imageFreshness.state === "stale";
  const metrics = useResourceMetrics({
    enabled: Boolean(session.status === "running" && hasRunnerUrl && metricsSocketUrl),
    sessionId: session.id,
    socketUrl: metricsSocketUrl || "",
  });

  useEffect(() => {
    setActiveCanvas(isManagedAgentSurface ? "agent" : "terminal");
  }, [workspaceId, session.id, isManagedAgentSurface]);

  useEffect(() => {
    setShowShell(false);
  }, [workspaceId, session.id]);

  return (
    <div className="session-detail">
      <SessionRuntimeStatus
        accessError={accessError}
        onRetryAccess={refreshAccess}
        session={session}
      />
      {!isManagedAgentSurface ? <div className="canvas-header">
        {(hasAgent || capabilities.preview || capabilities.chrome) ? (
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
        {metricsSocketUrl && session.status === "running" ? (
          <ResourceUtilization sample={metrics.sample} connectionState={metrics.connectionState} />
        ) : null}
      </div> : null}
      {isProvisioning ? (
        <div aria-live="polite" className="provisioning-status">
          <strong>{session.provisioningState === "queued" ? "Queued for provisioning" : "Provisioning in progress"}</strong>
          <span>The session will become available when its runner is ready.</span>
        </div>
      ) : null}
      {isProvisioningFailure ? (
        <div aria-live="polite" className="provisioning-status provisioning-status--failure">
          <strong>Provisioning failed</strong>
          <span>{isRetryableFailure ? "Retry provisioning to try again." : "Restart the session to try again."}</span>
        </div>
      ) : null}
      {imageFreshness.state !== "unknown" ? (
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
          busy={busy}
          capabilities={capabilities}
          hasAgent={hasAgent}
          hasBrowser={hasBrowser}
          hasPreview={hasPreview}
          hasRunnerUrl={hasRunnerUrl}
          isRestartBlocked={isRestartBlocked}
          isRetryableFailure={isRetryableFailure}
          isStaleImage={isStaleImage}
          metrics={metricsSocketUrl && session.status === "running" ? <ResourceUtilization sample={metrics.sample} connectionState={metrics.connectionState} /> : null}
          onAccessRefreshNeeded={refreshAfterConnectionFailure}
          onRestartSession={onRestartSession}
          onRetryProvisioningSession={onRetryProvisioningSession}
          onStopSession={onStopSession}
          session={session}
          setActiveCanvas={setActiveCanvas}
        />
      ) : <>
      <div className="canvas-shell">
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
                Preview is waiting for session access.
                <br />
                <code>{accessError || session.lastError || session.status}</code>
              </p>
            </div>
          )
        ) : null}
      </div>
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
          ) : isProvisioning ? null : (
            <Button
              aria-label={isStaleImage ? "Restart session to pick up the latest container image" : "Restart"}
              className={isStaleImage ? "session-restart-button--stale" : ""}
              disabled={busy || isRestartBlocked}
              title={isRestartBlocked ? "Restart is disabled until the server confirms the stop outcome" : isStaleImage ? "Restart to pick up the latest container image" : "Restart"}
              variant="secondary"
              onClick={() => onRestartSession(session.id)}
            >
              <RotateCcw aria-hidden="true" />
              Restart
            </Button>
          )}

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
