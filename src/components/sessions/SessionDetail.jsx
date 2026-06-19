import "./SessionDetail.css";
import {Copy, ExternalLink, Mail, RotateCcw, Share2, UploadCloud} from "lucide-react";
import {useEffect, useRef, useState} from "react";
import {Button} from "../common/Button.jsx";
import {GitStatusPanel} from "./GitStatusPanel.jsx";

const cpuOptions = ["1", "2", "4"];
const memoryOptions = ["1Gi", "2Gi", "4Gi", "8Gi"];

function formatMemory(value) {
  return value.replace("Gi", " GiB");
}

export function SessionDetail({
  busy,
  gitStatus,
  isGithubWorkspace,
  session,
  workspaceId,
  onCommitGit,
  onGetSessionAccessUrls,
  onOpenPullRequest,
  onPullGit,
  onPushGit,
  onResizeSession,
  onRestartSession,
  onShareSessionPreview,
  onStageGitPath,
  onUnstageGitPath,
  onUpdateGitCommitMessage,
}) {
  const formRef = useRef(null);
  const [activeCanvas, setActiveCanvas] = useState("terminal");
  const [accessUrls, setAccessUrls] = useState(null);
  const [accessError, setAccessError] = useState("");
  const [shareState, setShareState] = useState({loading: false, error: "", preview: null, copied: false});
  const [publishOpen, setPublishOpen] = useState(false);
  const capabilities = session.capabilities || {};
  const hasRunnerUrl = Boolean(session.serviceUrl);
  const hasTerminal = Boolean(hasRunnerUrl && accessUrls?.terminalUrl);
  const hasPreview = Boolean(capabilities.preview && hasRunnerUrl && accessUrls?.previewUrl);
  const showGitStatus = Boolean(hasRunnerUrl && isGithubWorkspace);

  useEffect(() => {
    let cancelled = false;
    setAccessUrls(null);
    setAccessError("");
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

  const handleResize = () => {
    const form = formRef.current;
    if (!form) return;
    const formData = new FormData(form);
    onResizeSession(session.id, {
      cpu: formData.get("resizeCpu"),
      memory: formData.get("resizeMemory"),
    });
  };

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
            disabled={!hasRunnerUrl}
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
          <Button disabled={busy} variant="secondary" onClick={() => onRestartSession(session.id)}>
            <RotateCcw aria-hidden="true" />
            Restart
          </Button>

        </div>
      </form>
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
