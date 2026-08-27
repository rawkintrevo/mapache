import "./SessionDetail.css";
import {Copy, ExternalLink, Mail, RotateCcw, Share2, SlidersHorizontal, UploadCloud} from "lucide-react";
import {useEffect, useState} from "react";
import {Button} from "../common/Button.jsx";
import {BrowserCanvas} from "./BrowserCanvas.jsx";
import {GitStatusPanel} from "./GitStatusPanel.jsx";
import {PiChatCanvas} from "./PiChatCanvas.jsx";
import {ResourceUtilization} from "./ResourceUtilization.jsx";
import {getSessionImageFreshness, isRetryableProvisioningFailure} from "./sessionPresentation.js";
import {derivePiChatSocketUrl} from "../../utils/piChat.js";
import {deriveResourceMetricsSocketUrl} from "../../utils/resourceMetrics.js";
import {useResourceMetrics} from "./useResourceMetrics.js";

export function SessionDetail({
  busy,
  gitStatus,
  isGithubWorkspace,
  session,
  sshForwards,
  workspaceId,
  onCommitGit,
  onGetSessionAccessUrls,
  onOpenPullRequest,
  onOpenPiModels,
  onPullGit,
  onPushGit,
  onRetryProvisioningSession,
  onRestartSession,
  onShareSessionPreview,
  onCloseSshSessionForward,
  onCreateSshSessionForward,
  onStageGitPath,
  onUnstageGitPath,
  onUpdateGitCommitMessage,
  onUpdateSshForwardPort,
}) {
  const [activeCanvas, setActiveCanvas] = useState("terminal");
  const [accessUrls, setAccessUrls] = useState(null);
  const [accessError, setAccessError] = useState("");
  const [shareState, setShareState] = useState({loading: false, error: "", preview: null, copied: false});
  const [publishOpen, setPublishOpen] = useState(false);
  const capabilities = session.capabilities || {};
  const hasRunnerUrl = Boolean(session.serviceUrl);
  const hasTerminal = Boolean(hasRunnerUrl && accessUrls?.terminalUrl);
  const hasPreview = Boolean(capabilities.preview && hasRunnerUrl && accessUrls?.previewUrl);
  const hasBrowser = Boolean(capabilities.chrome && hasRunnerUrl && accessUrls?.browserUrl);
  const chatSocketUrl = derivePiChatSocketUrl(accessUrls?.terminalUrl, capabilities);
  const hasChat = Boolean(capabilities.chat && hasRunnerUrl && chatSocketUrl);
  const metricsSocketUrl = deriveResourceMetricsSocketUrl(accessUrls?.terminalUrl);
  const showGitStatus = Boolean(hasRunnerUrl && isGithubWorkspace);
  const isSshSession = session.sessionType === "ssh" || session.terminalKind === "ssh";
  const isProvisioning = session.status === "provisioning";
  const isProvisioningFailure = session.status === "provision_failed";
  const isRetryableFailure = isRetryableProvisioningFailure(session);
  const imageFreshness = getSessionImageFreshness(session);
  const isStaleImage = imageFreshness.state === "stale";
  const metrics = useResourceMetrics({
    enabled: Boolean(session.status === "running" && hasRunnerUrl && !isSshSession && metricsSocketUrl),
    sessionId: session.id,
    socketUrl: metricsSocketUrl || "",
  });

  useEffect(() => {
    let cancelled = false;
    setAccessUrls(null);
    setAccessError("");
    setActiveCanvas("terminal");
    if (!workspaceId || !session.id || !session.serviceUrl || !onGetSessionAccessUrls) return undefined;

    onGetSessionAccessUrls(workspaceId, session.id)
        .then((urls) => {
          if (cancelled) return;
          setAccessUrls(urls);
        })
        .catch((error) => {
          if (cancelled) return;
          setAccessError(error.message || "session_access_unavailable");
        });

    return () => {
      cancelled = true;
    };
  }, [workspaceId, session.id, session.serviceUrl, onGetSessionAccessUrls]);

  useEffect(() => {
    setShareState({loading: false, error: "", preview: null, copied: false});
    setPublishOpen(false);
  }, [workspaceId, session.id]);

  const handleSharePreview = async () => {
    if (!workspaceId || !session.id || !onShareSessionPreview) return;
    setShareState((current) => ({...current, loading: true, error: "", copied: false}));
    try {
      const preview = await onShareSessionPreview(workspaceId, session.id);
      setShareState({loading: false, error: "", preview, copied: false});
    } catch (error) {
      setShareState({loading: false, error: error.message || "preview_share_failed", preview: null, copied: false});
    }
  };

  const handleCopyPreviewUrl = async () => {
    const url = shareState.preview?.publicUrl;
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setShareState((current) => ({...current, copied: true}));
  };

  return (
    <div className="session-detail">
      <div className="canvas-header">
        {hasChat || capabilities.preview || capabilities.chrome ? (
          <div className="canvas-tabs" role="tablist" aria-label="Session canvases">
          <Button
            aria-selected={activeCanvas === "terminal"}
            role="tab"
            variant={activeCanvas === "terminal" ? "primary" : "secondary"}
            onClick={() => setActiveCanvas("terminal")}
          >
            Terminal
          </Button>
          {hasChat ? (
            <Button
              aria-selected={activeCanvas === "chat"}
              role="tab"
              variant={activeCanvas === "chat" ? "primary" : "secondary"}
              onClick={() => setActiveCanvas("chat")}
            >
              Chat
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
        {metricsSocketUrl && !isSshSession && session.status === "running" ? (
          <ResourceUtilization sample={metrics.sample} connectionState={metrics.connectionState} />
        ) : null}
      </div>
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
      <div className="canvas-shell">
        {activeCanvas === "chat" && capabilities.chat ? (
          <PiChatCanvas
            error={accessError || (!chatSocketUrl && accessUrls ? "chat_access_unavailable" : "")}
            onOpenTerminal={() => setActiveCanvas("terminal")}
            sessionId={session.id}
            sessionName={session.name}
            socketUrl={chatSocketUrl}
          />
        ) : activeCanvas === "chrome" && capabilities.chrome ? (
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
        ) : activeCanvas === "preview" && capabilities.preview ? (
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
        ) : hasTerminal ? (
          <iframe
            allow="clipboard-read; clipboard-write"
            src={accessUrls.terminalUrl}
            title={`Terminal ${session.name}`}
          />
        ) : (
          <div className="terminal-placeholder">
            <p>
              Terminal access is not ready.
              <br />
              <code>{accessError || session.lastError || session.status}</code>
            </p>
          </div>
        )}
      </div>
      <div className="toolbar">
        <div className="session-actions">
          {session.harnessId === "pi" || session.terminalKind === "pi" ? (
            <Button disabled={busy || !hasRunnerUrl} variant="secondary" onClick={onOpenPiModels}>
              <SlidersHorizontal aria-hidden="true" />
              Models
            </Button>
          ) : null}
          {capabilities.preview ? (
            <>
              <Button
                disabled={busy || !hasRunnerUrl || shareState.loading}
                variant="secondary"
                onClick={handleSharePreview}
              >
                <Share2 aria-hidden="true" />
                {shareState.loading ? "Sharing..." : "Share Preview"}
              </Button>
              <Button variant="secondary" onClick={() => setPublishOpen((open) => !open)}>
                <UploadCloud aria-hidden="true" />
                Publish
              </Button>
            </>
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
          ) : isProvisioning ? null : (
            <Button
              aria-label={isStaleImage ? "Restart session to pick up the latest container image" : "Restart"}
              className={isStaleImage ? "session-restart-button--stale" : ""}
              disabled={busy}
              title={isStaleImage ? "Restart to pick up the latest container image" : "Restart"}
              variant="secondary"
              onClick={() => onRestartSession(session.id)}
            >
              <RotateCcw aria-hidden="true" />
              Restart
            </Button>
          )}

        </div>
      </div>
      {capabilities.preview ? (
        <div className="preview-share-panel" aria-live="polite">
          {shareState.error ? (
            <p className="preview-share-error">{friendlyPreviewShareError(shareState.error)}</p>
          ) : null}
          {shareState.preview?.publicUrl ? (
            <div className="preview-url-row">
              <div>
                <span>Public preview</span>
                <a href={shareState.preview.publicUrl} rel="noreferrer" target="_blank">
                  {shareState.preview.publicUrl}
                </a>
              </div>
              <Button aria-label="Copy public preview URL" variant="secondary" onClick={handleCopyPreviewUrl}>
                <Copy aria-hidden="true" />
                {shareState.copied ? "Copied" : "Copy"}
              </Button>
              <Button
                aria-label="Open public preview"
                variant="secondary"
                onClick={() => window.open(shareState.preview.publicUrl, "_blank", "noopener,noreferrer")}
              >
                <ExternalLink aria-hidden="true" />
                Open
              </Button>
            </div>
          ) : null}
          {publishOpen ? (
            <div className="publish-panel">
              <p>Automated publishing is not available yet.</p>
              <a href="mailto:trevor@ata.systems">
                <Mail aria-hidden="true" />
                Contact trevor@ata.systems for help publishing your website.
              </a>
            </div>
          ) : null}
        </div>
      ) : null}
      {isSshSession ? (
        <div className="ssh-forward-panel">
          <form
            className="toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              onCreateSshSessionForward?.();
            }}
          >
            <label>
              <span>Forward port</span>
              <input
                inputMode="numeric"
                placeholder="5173"
                value={sshForwards?.port || ""}
                onChange={(event) => onUpdateSshForwardPort?.(event.target.value)}
              />
            </label>
            <Button disabled={busy || !hasRunnerUrl || sshForwards?.loading || !sshForwards?.port} type="submit">
              <ExternalLink aria-hidden="true" />
              Open
            </Button>
          </form>
          {sshForwards?.error ? <p className="preview-share-error">{sshForwards.error}</p> : null}
          {sshForwards?.forwards?.length ? (
            <div className="ssh-forward-list">
              {sshForwards.forwards.map((forward) => {
                const url = sshForwardUrl(accessUrls?.sshForwardBaseUrl, forward.port);
                return (
                  <div className="preview-url-row" key={forward.port}>
                    <div>
                      <span>localhost:{forward.port}</span>
                      {url ? <a href={url} rel="noreferrer" target="_blank">{url}</a> : null}
                    </div>
                    <Button disabled={!url} variant="secondary" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>
                      <ExternalLink aria-hidden="true" />
                      Open
                    </Button>
                    <Button variant="secondary" onClick={() => onCloseSshSessionForward?.(forward.port)}>
                      Close
                    </Button>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {showGitStatus ? (
        <GitStatusPanel
          busy={busy}
          gitStatus={gitStatus}
          session={session}
          onCommitGit={onCommitGit}
          onOpenPullRequest={onOpenPullRequest}
          onPullGit={onPullGit}
          onPushGit={onPushGit}
          onStageGitPath={onStageGitPath}
          onUnstageGitPath={onUnstageGitPath}
          onUpdateGitCommitMessage={onUpdateGitCommitMessage}
        />
      ) : null}
    </div>
  );
}

function sshForwardUrl(baseUrl, port) {
  if (!baseUrl || !port) return "";
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeURIComponent(port)}/`;
  return url.toString();
}

function friendlyPreviewShareError(message) {
  if (message === "preview_static_build_not_ready") return "Build the static website into /workspace/build before sharing.";
  if (message === "preview_share_requires_static_build") return "Share Preview only supports static build output.";
  if (message === "session_not_running") return "Start the session before sharing a preview.";
  if (message === "runner_preview_share_unavailable") return "Preview sharing is temporarily unavailable.";
  if (message === "session_preview_not_supported") return "This session does not support website previews.";
  if (message === "preview_static_build_too_large") return "The static build is too large to share as a preview.";
  if (message === "preview_static_build_too_many_files") return "The static build has too many files to share as a preview.";
  return message || "Preview sharing failed.";
}
