import "./Topbar.css";
import {Bot} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {TopbarUserMenu} from "./TopbarUserMenu.jsx";
import {TopbarMoreMenu} from "./TopbarMoreMenu.jsx";
import {TopbarPowerMenu} from "./TopbarPowerMenu.jsx";
import {hasPendingOperations} from "../../state/pendingOperations.js";
import {getWorkspacePowerPresentation, isMarkedRuntimeSession, isRuntimeStopUncertain, isSessionResizePending} from "../sessions/sessionPresentation.js";
import {normalizeSessionImageKey} from "../../config/sessionImages.js";
import {sessionAuthHarness, sessionSupportsAuth} from "../../utils/sessionHarnesses.js";
import {ResourceUtilization} from "../sessions/ResourceUtilization.jsx";
import {SessionRuntimePolicy} from "../sessions/SessionRuntimePolicy.jsx";

export function Topbar({
  activeCanvas,
  state,
  selectedSession,
  onDeleteWorkspace,
  onOpenGenericEnvironment,
  onOpenGoogleWorkspace,
  onOpenMcpServers,
  onOpenRequestGrants,
  onOpenPiAuthManage,
  onOpenWorkspaceEditModal,
  onOpenWorkspaceModal,
  onRefresh,
  onRestartWorkspace,
  onSelectCanvas,
  onSelectWorkspace,
  onShowAdmin,
  onShowAutomations,
  onShowInstances,
  onShowLogs,
  onShowUpload,
  onShowProfile,
  onSignOut,
  onSetRuntimePolicy,
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
  const workspacePowerPresentation = getWorkspacePowerPresentation(canonicalSession);
  const workspaceTransitioning = [
    "provisioning", "queued", "restarting", "resizing", "needs_service", "stopping", "deleting", "updating",
  ].includes(sessionStatus) || isSessionResizePending(canonicalSession) || workspacePowerPresentation.state === "transition";
  const workspaceOn = ["running", "ready"].includes(sessionStatus) ||
    String(canonicalSession?.agentRuntimeState || "").toLowerCase() === "running";
  const hasSessionImageMetadata = Boolean(canonicalSession?.imageKey || canonicalSession?.image);
  const workspaceUnsupported = selectedWorkspace?.source?.type === "ssh" ||
    Boolean(canonicalSession && hasSessionImageMetadata && normalizeSessionImageKey(canonicalSession) !== "pi-chrome");
  const workspaceStartBlocked = workspaceUnsupported && !workspaceOn;
  const workspaceStopUncertain = isRuntimeStopUncertain(canonicalSession || {});
  const workspaceActionDisabled = busy || !selectedWorkspace || workspaceTransitioning || workspaceStartBlocked || workspaceStopUncertain;
  const workspaceRestartDisabled = workspaceActionDisabled || !canonicalSession || !workspaceOn || workspaceUnsupported;
  const authHarness = sessionAuthHarness(canonicalSession);
  const showManagePiAuth = sessionSupportsAuth(canonicalSession);
  const managePiAuthLabel = authHarness?.manageTitle || "Manage Pi Auth";
  const showWorkspaceTools = isMarkedRuntimeSession(canonicalSession);
  const showRuntimePolicy = Boolean(selectedWorkspace) && selectedWorkspace.source?.type !== "ssh" &&
    (selectedWorkspace.agentUiVersion === "pi-web-ui-v1" || isMarkedRuntimeSession(canonicalSession));

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
        <TopbarPowerMenu
          actionDisabled={workspaceActionDisabled}
          onRestart={onRestartWorkspace}
          onToggle={onToggleWorkspace}
          restartDisabled={workspaceRestartDisabled}
          workspacePowerPresentation={workspacePowerPresentation}
          workspaceOn={workspaceOn}
        />
        {showRuntimePolicy ? (
          <SessionRuntimePolicy
            disabled={busy}
            onSave={(policy) => onSetRuntimePolicy?.(policy)}
            session={canonicalSession}
            workspace={selectedWorkspace}
          />
        ) : null}
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
          </>
        ) : null}
        </div>
        <TopbarMoreMenu
          activeCanvas={activeCanvas}
          disabled={busy}
          onRefresh={onRefresh}
          onSelectCanvas={onSelectCanvas}
          onShowAutomations={onShowAutomations}
          onShowLogs={onShowLogs}
          onShowUpload={workspaceUnsupported ? null : onShowUpload}
          showWorkspaceTools={showWorkspaceTools}
          managePiAuthLabel={managePiAuthLabel}
          genericEnvironmentDisabled={state.piAuth?.loading || state.piAuth?.saving || !onOpenGenericEnvironment}
          googleWorkspaceDisabled={state.googleWorkspace?.loading || state.googleWorkspace?.saving || !onOpenGoogleWorkspace}
          mcpServersDisabled={state.mcpServers?.loading || state.mcpServers?.saving || !onOpenMcpServers}
          piAuthDisabled={state.piAuth?.loading || state.piAuth?.saving || !showManagePiAuth || !onOpenPiAuthManage}
          onDeleteWorkspace={onDeleteWorkspace}
          onOpenGenericEnvironment={onOpenGenericEnvironment}
          onOpenGoogleWorkspace={onOpenGoogleWorkspace}
          onOpenMcpServers={onOpenMcpServers}
          onOpenRequestGrants={onOpenRequestGrants}
          onOpenPiAuthManage={onOpenPiAuthManage}
          onOpenWorkspaceEditModal={onOpenWorkspaceEditModal}
          onOpenWorkspaceModal={onOpenWorkspaceModal}
          selectedWorkspace={selectedWorkspace}
        />
        <TopbarUserMenu
          state={state}
          onRefresh={onRefresh}
          onShowAdmin={onShowAdmin}
          onShowInstances={onShowInstances}
          onShowProfile={onShowProfile}
          onSignOut={onSignOut}
        />
      </div>
    </header>
  );
}
