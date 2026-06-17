import {RotateCcw} from "lucide-react";
import {useEffect, useRef, useState} from "react";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "../modals/ModalBackdrop.jsx";
import {GitStatusPanel} from "./GitStatusPanel.jsx";

const cpuOptions = ["1", "2", "4"];
const memoryOptions = ["1Gi", "2Gi", "4Gi", "8Gi"];
const previewRootOptions = [
  {label: "build", value: "build"},
  {label: "dist", value: "dist"},
  {label: "out", value: "out"},
  {label: "public", value: "public"},
];
const chooseOtherPreviewRoot = "__choose_other__";

function formatMemory(value) {
  return value.replace("Gi", " GiB");
}

function displayPreviewRoot(value) {
  const clean = String(value || "/workspace/build").trim();
  return clean.startsWith("/workspace/") ? clean.slice("/workspace/".length) : clean.replace(/^\/+/, "");
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
  onStageGitPath,
  onUnstageGitPath,
  onUpdateGitCommitMessage,
  onUpdateSessionPreviewRoot,
}) {
  const formRef = useRef(null);
  const [activeCanvas, setActiveCanvas] = useState("terminal");
  const [accessUrls, setAccessUrls] = useState(null);
  const [accessError, setAccessError] = useState("");
  const [previewRootModalOpen, setPreviewRootModalOpen] = useState(false);
  const [customPreviewRoot, setCustomPreviewRoot] = useState("");
  const capabilities = session.capabilities || {};
  const hasRunnerUrl = Boolean(session.serviceUrl);
  const hasTerminal = Boolean(hasRunnerUrl && accessUrls?.terminalUrl);
  const hasPreview = Boolean(capabilities.preview && hasRunnerUrl && accessUrls?.previewUrl);
  const previewRoot = displayPreviewRoot(session.previewStaticRoot);
  const hasCustomPreviewRoot = !previewRootOptions.some((option) => option.value === previewRoot);
  const showPreviewRootControl = Boolean(session.imageKey === "pi-web" && capabilities.preview);
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

  const handleResize = () => {
    const form = formRef.current;
    if (!form) return;
    const formData = new FormData(form);
    onResizeSession(session.id, {
      cpu: formData.get("resizeCpu"),
      memory: formData.get("resizeMemory"),
    });
  };

  const handlePreviewRootChange = (event) => {
    const value = event.target.value;
    if (value === chooseOtherPreviewRoot) {
      setCustomPreviewRoot(previewRoot);
      setPreviewRootModalOpen(true);
      return;
    }
    onUpdateSessionPreviewRoot(session.id, {previewStaticRoot: value});
  };

  const handleCustomPreviewRootSubmit = (event) => {
    event.preventDefault();
    const value = customPreviewRoot.trim();
    if (!value) return;
    onUpdateSessionPreviewRoot(session.id, {previewStaticRoot: value});
    setPreviewRootModalOpen(false);
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
        {showPreviewRootControl ? (
          <label>
            <span>Preview folder</span>
            <select value={hasCustomPreviewRoot ? previewRoot : previewRoot || "build"} onChange={handlePreviewRootChange}>
              {previewRootOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
              {hasCustomPreviewRoot ? <option value={previewRoot}>{previewRoot}</option> : null}
              <option disabled value="">------</option>
              <option value={chooseOtherPreviewRoot}>Choose other...</option>
            </select>
          </label>
        ) : null}
        <div className="session-actions">
          <Button disabled={busy} onClick={handleResize}>Resize</Button>
          <Button disabled={busy} variant="secondary" onClick={() => onRestartSession(session.id)}>
            <RotateCcw aria-hidden="true" />
            Restart
          </Button>

        </div>
      </form>
      {previewRootModalOpen ? (
        <ModalBackdrop onClose={() => setPreviewRootModalOpen(false)}>
          <form className="modal-panel preview-root-panel" onSubmit={handleCustomPreviewRootSubmit}>
            <div className="modal-heading">
              <div>
                <h2>Preview folder</h2>
                <p className="subtle">Path under /workspace</p>
              </div>
              <Button variant="secondary" onClick={() => setPreviewRootModalOpen(false)}>Close</Button>
            </div>
            <label>
              <span>Folder path</span>
              <input
                autoFocus
                placeholder="dist"
                value={customPreviewRoot}
                onChange={(event) => setCustomPreviewRoot(event.target.value)}
              />
            </label>
            <div className="session-actions">
              <Button disabled={busy || !customPreviewRoot.trim()} type="submit">Save</Button>
              <Button disabled={busy} variant="secondary" onClick={() => setPreviewRootModalOpen(false)}>Cancel</Button>
            </div>
          </form>
        </ModalBackdrop>
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
