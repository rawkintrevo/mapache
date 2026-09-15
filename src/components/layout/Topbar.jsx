import "./Topbar.css";
import {Blocks, Bot, KeyRound, Pause, Pencil, Play, PlugZap, Plus, RefreshCw, ScrollText, Trash2, Variable} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {TopbarUserMenu} from "./TopbarUserMenu.jsx";
import {TopbarMoreMenu} from "./TopbarMoreMenu.jsx";
import {hasPendingOperations} from "../../state/pendingOperations.js";
import {isMarkedRuntimeSession, isRuntimeStopUncertain, isSessionResizePending} from "../sessions/sessionPresentation.js";
import {normalizeSessionImageKey} from "../../config/sessionImages.js";
import {sessionAuthHarness, sessionSupportsAuth} from "../../utils/sessionHarnesses.js";
import {ResourceUtilization} from "../sessions/ResourceUtilization.jsx";

export function Topbar({
  activeCanvas,
  state,
  selectedSession,
  onDeleteWorkspace,
  onOpenGenericEnvironment,
  onOpenGoogleWorkspace,
  onOpenMcpServers,
  onOpenPiAuthManage,
  onOpenWorkspaceEditModal,
  onOpenWorkspaceModal,
  onRefresh,
  onSelectCanvas,
  onSelectWorkspace,
  onShowAdmin,
  onShowLogs,
  onShowProfile,
  onSignOut,
  onToggleWorkspace,
  resourceMetrics,
}) {
  const busy = hasPendingOperations(state.pendingOperations);
  const selectedWorkspace = state.workspaces.find(
      (workspace) => workspace.id === state.selectedWorkspaceId,
  );
  const canonicalSession = selectedSession || state.sessions.find(
      (session) => session.id === selectedWorkspace?.canonicalSessionId,
  ) || state.sessions.find((session) => session.id === state.selectedSessionId) || state.sessions[0];
  const sessionStatus = String(canonicalSession?.status || "").toLowerCase();
  const workspaceTransitioning = [
    "provisioning", "queued", "restarting", "resizing", "needs_service", "stopping", "deleting",
  ].includes(sessionStatus) || isSessionResizePending(canonicalSession);
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
  const showWorkspaceTools = isMarkedRuntimeSession(canonicalSession);

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
        <div className="topbar-workspace-secondary">
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
      </div>
      {resourceMetrics ? (
        <ResourceUtilization
          connectionState={resourceMetrics.connectionState}
          navbar
          sample={resourceMetrics.sample}
        />
      ) : null}
      <div className="topbar-actions">
        <div className="topbar-secondary-actions">
        {showWorkspaceTools ? (
          <>
            <Button
              aria-label="Agent"
              aria-pressed={state.activePage === "workspace" && activeCanvas === "agent"}
              disabled={!canonicalSession?.serviceUrl}
              icon
              title="Agent"
              tooltip="Agent"
              variant={state.activePage === "workspace" && activeCanvas === "agent" ? "primary" : "secondary"}
              onClick={() => {
                onSelectCanvas?.("agent");
                if (state.activePage !== "workspace" && selectedWorkspace) onSelectWorkspace?.(selectedWorkspace.id);
              }}
            >
              <Bot aria-hidden="true" />
            </Button>
            <Button
              aria-label="Logs"
              icon
              title="Logs"
              tooltip="Logs"
              variant="secondary"
              onClick={onShowLogs}
            >
              <ScrollText aria-hidden="true" />
            </Button>
            <span aria-hidden="true" className="topbar-action-divider" />
          </>
        ) : null}
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
        <Button
          aria-label="Manage MCP servers"
          disabled={!selectedWorkspace || state.mcpServers?.loading || state.mcpServers?.saving || !onOpenMcpServers}
          icon
          title="Manage MCP servers"
          tooltip="Manage MCP servers"
          variant="secondary"
          onClick={onOpenMcpServers}
        >
          <PlugZap aria-hidden="true" />
        </Button>
        <Button
          aria-label="Manage Google Workspace"
          disabled={!selectedWorkspace || state.googleWorkspace?.loading || state.googleWorkspace?.saving || !onOpenGoogleWorkspace}
          icon
          title="Manage Google Workspace"
          tooltip="Manage Google Workspace"
          variant="secondary"
          onClick={onOpenGoogleWorkspace}
        >
          <Blocks aria-hidden="true" />
        </Button>
        <a className="topbar-link" href="/community/blog">Blog</a>
        <a className="topbar-link" href="/community/docs/intro/">Docs</a>
        </div>
        <TopbarMoreMenu
          activeCanvas={activeCanvas}
          disabled={busy}
          onRefresh={onRefresh}
          onSelectCanvas={onSelectCanvas}
          onShowLogs={onShowLogs}
          showWorkspaceTools={showWorkspaceTools}
          managePiAuthLabel={managePiAuthLabel}
          onDeleteWorkspace={onDeleteWorkspace}
          onOpenGenericEnvironment={onOpenGenericEnvironment}
          onOpenGoogleWorkspace={onOpenGoogleWorkspace}
          onOpenMcpServers={onOpenMcpServers}
          onOpenPiAuthManage={showManagePiAuth ? onOpenPiAuthManage : null}
          onOpenWorkspaceEditModal={onOpenWorkspaceEditModal}
          onOpenWorkspaceModal={onOpenWorkspaceModal}
          selectedWorkspace={selectedWorkspace}
        />
        <Button
          aria-label="Refresh app state"
          className="topbar-refresh-button"
          disabled={busy}
          icon
          title={busy ? "Working..." : "Refresh"}
          variant="secondary"
          onClick={onRefresh}
        >
          <RefreshCw aria-hidden="true" />
        </Button>
        <TopbarUserMenu
          state={state}
          onRefresh={onRefresh}
          onShowAdmin={onShowAdmin}
          onShowProfile={onShowProfile}
          onSignOut={onSignOut}
        />
      </div>
    </header>
  );
}
