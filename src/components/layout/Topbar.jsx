import "./Topbar.css";
import {KeyRound, Pause, Pencil, Play, Plus, RefreshCw, Trash2, Variable} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {hasPendingOperations} from "../../state/pendingOperations.js";
import {isRuntimeStopUncertain} from "../sessions/sessionPresentation.js";
import {normalizeSessionImageKey} from "../../config/sessionImages.js";
import {sessionAuthHarness, sessionSupportsAuth} from "../../utils/sessionHarnesses.js";

export function Topbar({
  state,
  onDeleteWorkspace,
  onOpenGenericEnvironment,
  onOpenPiAuthManage,
  onOpenWorkspaceEditModal,
  onOpenWorkspaceModal,
  onRefresh,
  onSelectWorkspace,
  onToggleWorkspace,
}) {
  const busy = hasPendingOperations(state.pendingOperations);
  const selectedWorkspace = state.workspaces.find(
      (workspace) => workspace.id === state.selectedWorkspaceId,
  );
  const canonicalSession = state.sessions.find(
      (session) => session.id === selectedWorkspace?.canonicalSessionId,
  ) || state.sessions.find((session) => session.id === state.selectedSessionId) || state.sessions[0];
  const sessionStatus = String(canonicalSession?.status || "").toLowerCase();
  const workspaceTransitioning = [
    "provisioning", "queued", "restarting", "resizing", "needs_service", "stopping", "deleting",
  ].includes(sessionStatus);
  const workspaceOn = ["running", "ready"].includes(sessionStatus);
  const hasSessionImageMetadata = Boolean(canonicalSession?.imageKey || canonicalSession?.image);
  const workspaceUnsupported = selectedWorkspace?.source?.type === "ssh" ||
    Boolean(canonicalSession && hasSessionImageMetadata && normalizeSessionImageKey(canonicalSession) !== "pi-chrome");
  const workspaceStartBlocked = workspaceUnsupported && !workspaceOn;
  const workspaceStopUncertain = isRuntimeStopUncertain(canonicalSession || {});
  const workspaceActionLabel = workspaceOn ? "Pause workspace" : "Start workspace";
  const authHarness = sessionAuthHarness(canonicalSession);
  const showManagePiAuth = sessionSupportsAuth(canonicalSession);
  const managePiAuthLabel = authHarness?.manageTitle || "Manage Auth";

  return (
    <header className="topbar">
      <div className="brand">
        <div aria-hidden="true" className="mark">pi</div>
        <h1>Mapache Tools</h1>
      </div>
      <div className="topbar-workspace-controls">
        <label className="visually-hidden" htmlFor="topbar-workspace-select">Workspace</label>
        <select
          aria-label="Workspace"
          className="topbar-workspace-select"
          disabled={busy || !state.workspaces.length}
          id="topbar-workspace-select"
          value={state.selectedWorkspaceId || ""}
          onChange={(event) => onSelectWorkspace(event.target.value)}
        >
          {!selectedWorkspace ? (
            <option value="">{state.workspaces.length ? "Select a workspace" : "No workspaces yet"}</option>
          ) : null}
          {state.workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
          ))}
        </select>
        <Button
          aria-label={workspaceActionLabel}
          disabled={busy || !selectedWorkspace || workspaceTransitioning || workspaceStartBlocked || workspaceStopUncertain}
          icon
          title={workspaceStartBlocked ? "This historical runtime cannot be started" : workspaceStopUncertain ? "Workspace stop is still being confirmed" : workspaceTransitioning ? "Workspace is changing state" : workspaceActionLabel}
          tooltip={workspaceStartBlocked ? "This historical runtime cannot be started" : workspaceStopUncertain ? "Workspace stop is still being confirmed" : workspaceTransitioning ? "Workspace is changing state" : workspaceActionLabel}
          variant="secondary"
          onClick={onToggleWorkspace}
        >
          {workspaceOn ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </Button>
        <Button
          aria-label="Create workspace"
          disabled={busy}
          icon
          title="Create workspace"
          tooltip="Create workspace"
          variant="secondary"
          onClick={onOpenWorkspaceModal}
        >
          <Plus aria-hidden="true" />
        </Button>
        <Button
          aria-label={selectedWorkspace ? `Edit workspace ${selectedWorkspace.name}` : "Edit selected workspace"}
          disabled={busy || !selectedWorkspace}
          icon
          title={selectedWorkspace ? `Edit workspace ${selectedWorkspace.name}` : "Edit selected workspace"}
          tooltip={selectedWorkspace ? `Edit workspace ${selectedWorkspace.name}` : "Edit selected workspace"}
          variant="secondary"
          onClick={onOpenWorkspaceEditModal}
        >
          <Pencil aria-hidden="true" />
        </Button>
        <Button
          aria-label={selectedWorkspace ? `Delete workspace ${selectedWorkspace.name}` : "Delete selected workspace"}
          disabled={busy || !selectedWorkspace}
          icon
          title={selectedWorkspace ? `Delete workspace ${selectedWorkspace.name}` : "Delete selected workspace"}
          tooltip={selectedWorkspace ? `Delete workspace ${selectedWorkspace.name}` : "Delete selected workspace"}
          variant="secondary"
          onClick={() => onDeleteWorkspace(selectedWorkspace?.id)}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
      <div className="topbar-actions">
        {showManagePiAuth ? (
          <Button
            aria-label={managePiAuthLabel}
            disabled={state.piAuth?.loading || state.piAuth?.saving || !onOpenPiAuthManage}
            icon
            title={managePiAuthLabel}
            tooltip={managePiAuthLabel}
            variant="secondary"
            onClick={onOpenPiAuthManage}
          >
            <KeyRound aria-hidden="true" />
          </Button>
        ) : null}
        <Button
          aria-label="Manage generic environment keys"
          disabled={state.piAuth?.loading || state.piAuth?.saving || !onOpenGenericEnvironment}
          icon
          title="Manage generic environment keys"
          tooltip="Manage generic environment keys"
          variant="secondary"
          onClick={onOpenGenericEnvironment}
        >
          <Variable aria-hidden="true" />
        </Button>
        <a className="topbar-link" href="/community/blog">Blog</a>
        <a className="topbar-link" href="/community/docs/intro/">Docs</a>
        <Button
          aria-label="Refresh app state"
          disabled={busy}
          icon
          title={busy ? "Working..." : "Refresh"}
          variant="secondary"
          onClick={onRefresh}
        >
          <RefreshCw aria-hidden="true" />
        </Button>
      </div>
    </header>
  );
}
