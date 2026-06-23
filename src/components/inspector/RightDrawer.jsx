import "../drawers/Drawers.css";
import "./InspectorPanels.css";
import {PanelRightClose, PanelRightOpen} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {AuthCenterPanel} from "./AuthCenterPanel.jsx";
import {ExtensionsPanel} from "./ExtensionsPanel.jsx";
import {McpServersPanel} from "./McpServersPanel.jsx";
import {SkillsPanel} from "./SkillsPanel.jsx";
import {SubagentsPanel} from "./SubagentsPanel.jsx";

export function RightDrawer({
  selectedSession,
  state,
  onInstallPiPackage,
  onCancelPiSkillEdit,
  onDeletePiAuthProvider,
  onDeletePiSkill,
  onDeleteWorkspaceSubagent,
  onDeleteMcpServer,
  onEditPiSkill,
  onEditWorkspaceSubagent,
  onOpenAuthModal,
  onOpenPiAuthManage,
  onOpenWorkspaceSkillModal,
  onOpenWorkspaceSubagentModal,
  onRefreshPiAuth,
  onRefreshMcpServers,
  onRefreshPiPackages,
  onRefreshPiSkills,
  onRefreshWorkspaceSubagents,
  onRemovePiPackage,
  onToggleDrawerSection,
  onToggleRightDrawer,
  onUpdatePiInstallSource,
  onUpdateMcpServerForm,
  onUpdatePiPackage,
  onSaveMcpServer,
  onCancelWorkspaceSubagentEdit,
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
        selectedSession={selectedSession}
        state={state}
        onDeletePiAuthProvider={onDeletePiAuthProvider}
        onOpenAuthModal={onOpenAuthModal}
        onOpenPiAuthManage={onOpenPiAuthManage}
        onRefreshPiAuth={onRefreshPiAuth}
        onToggleDrawerSection={onToggleDrawerSection}
      />
      <SkillsPanel
        workspaceSkills={state.workspaceSkills}
        selectedSession={selectedSession}
        state={state}
        onCancelWorkspaceSkillEdit={onCancelPiSkillEdit}
        onDeleteWorkspaceSkill={onDeletePiSkill}
        onEditWorkspaceSkill={onEditPiSkill}
        onOpenWorkspaceSkillModal={onOpenWorkspaceSkillModal}
        onRefreshWorkspaceSkills={onRefreshPiSkills}
        onToggleDrawerSection={onToggleDrawerSection}
      />
      <SubagentsPanel
        selectedSession={selectedSession}
        state={state}
        workspaceSubagents={state.workspaceSubagents}
        onCancelWorkspaceSubagentEdit={onCancelWorkspaceSubagentEdit}
        onDeleteWorkspaceSubagent={onDeleteWorkspaceSubagent}
        onEditWorkspaceSubagent={onEditWorkspaceSubagent}
        onOpenWorkspaceSubagentModal={onOpenWorkspaceSubagentModal}
        onRefreshWorkspaceSubagents={onRefreshWorkspaceSubagents}
        onToggleDrawerSection={onToggleDrawerSection}
      />
      <McpServersPanel
        mcpServers={state.mcpServers}
        state={state}
        onDeleteMcpServer={onDeleteMcpServer}
        onRefreshMcpServers={onRefreshMcpServers}
        onSaveMcpServer={onSaveMcpServer}
        onToggleDrawerSection={onToggleDrawerSection}
        onUpdateMcpServerForm={onUpdateMcpServerForm}
      />
      <ExtensionsPanel
        piPackages={state.piPackages}
        selectedSession={selectedSession}
        state={state}
        onInstallPiPackage={onInstallPiPackage}
        onRefreshPiPackages={onRefreshPiPackages}
        onRemovePiPackage={onRemovePiPackage}
        onToggleDrawerSection={onToggleDrawerSection}
        onUpdatePiInstallSource={onUpdatePiInstallSource}
        onUpdatePiPackage={onUpdatePiPackage}
      />
    </aside>
  );
}
