import "../drawers/Drawers.css";
import "./InspectorPanels.css";
import {PanelRightClose, PanelRightOpen} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {AuthCenterPanel} from "./AuthCenterPanel.jsx";
import {GoogleWorkspacePanel} from "./GoogleWorkspacePanel.jsx";
import {McpServersPanel} from "./McpServersPanel.jsx";

export function RightDrawer({
  selectedSession,
  selectedWorkspace,
  state,
  onDeleteMcpServer,
  onEditMcpServer,
  onDeleteGoogleConnection,
  onEditGoogleConnection,
  onNewMcpServer,
  onRefreshPiAuth,
  onRefreshMcpServers,
  onRefreshGoogleWorkspace,
  onToggleDrawerSection,
  onToggleRightDrawer,
  onUpdateMcpServerForm,
  onSaveMcpServer,
  onBindGoogleConnection,
  onUnbindGoogleConnection,
}) {
  const toggleButton = (
    <Button
      aria-expanded={String(!state.rightDrawerCollapsed)}
      aria-label={state.rightDrawerCollapsed ? "Expand inspector" : "Collapse inspector"}
      className="drawer-toggle"
      icon={true}
      title={state.rightDrawerCollapsed ? "Expand inspector" : "Collapse inspector"}
      tooltip={state.rightDrawerCollapsed ? "Expand inspector" : "Collapse inspector"}
      variant="secondary"
      onClick={onToggleRightDrawer}
    >
      {state.rightDrawerCollapsed ? <PanelRightOpen aria-hidden="true" /> : <PanelRightClose aria-hidden="true" />}
    </Button>
  );

  if (state.rightDrawerCollapsed) {
    return <aside className="drawer inspector collapsed">{toggleButton}</aside>;
  }

  return (
    <aside className="drawer inspector">
      <div className="drawer-header">
        <h2>Inspector</h2>
        {toggleButton}
      </div>
      <AuthCenterPanel
        piAuth={state.piAuth}
        state={state}
        onRefreshPiAuth={onRefreshPiAuth}
        onToggleDrawerSection={onToggleDrawerSection}
      />
      <McpServersPanel
        mcpServers={state.mcpServers}
        state={state}
        onDeleteMcpServer={onDeleteMcpServer}
        onEditMcpServer={onEditMcpServer}
        onNewMcpServer={onNewMcpServer}
        onRefreshMcpServers={onRefreshMcpServers}
        onSaveMcpServer={onSaveMcpServer}
        onToggleDrawerSection={onToggleDrawerSection}
        onUpdateMcpServerForm={onUpdateMcpServerForm}
      />
      <GoogleWorkspacePanel
        googleWorkspace={state.googleWorkspace}
        state={state}
        onBindConnection={onBindGoogleConnection}
        onDeleteConnection={onDeleteGoogleConnection}
        onEditConnection={onEditGoogleConnection}
        onRefresh={onRefreshGoogleWorkspace}
        onToggleDrawerSection={onToggleDrawerSection}
        onUnbindConnection={onUnbindGoogleConnection}
      />
    </aside>
  );
}
