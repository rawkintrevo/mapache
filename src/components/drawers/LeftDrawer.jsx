import {DrawerSessionList} from "./DrawerSessionList.jsx";
import {DrawerSection} from "./DrawerSection.jsx";
import {UserMenu} from "./UserMenu.jsx";
import {WorkspaceDrawerList} from "./WorkspaceDrawerList.jsx";
import {WorkspaceFileTree} from "../files/WorkspaceFileTree.jsx";

export function LeftDrawer({
  state,
  onDeleteSession,
  onOpenSessionModal,
  onOpenWorkspaceModal,
  onRefresh,
  onRefreshWorkspaceFiles,
  onSelectSession,
  onSelectWorkspace,
  onSelectWorkspaceFile,
  onShowProfile,
  onSignOut,
  onStopSession,
  onToggleDrawer,
  onToggleDrawerSection,
  onToggleWorkspaceFileDir,
}) {
  const toggleButton = (
    <button
      aria-expanded={String(!state.drawerCollapsed)}
      aria-label={state.drawerCollapsed ? "Expand drawer" : "Collapse drawer"}
      className="drawer-toggle secondary"
      title={state.drawerCollapsed ? "Expand drawer" : "Collapse drawer"}
      type="button"
      onClick={onToggleDrawer}
    >
      <span aria-hidden="true" className="icon">{state.drawerCollapsed ? "☰" : "‹"}</span>
    </button>
  );

  if (state.drawerCollapsed) {
    return <aside className="drawer navigation-drawer collapsed">{toggleButton}</aside>;
  }

  return (
    <aside className="drawer navigation-drawer">
      <div className="drawer-content">
        <div className="drawer-header">
          <h2>Navigation</h2>
          {toggleButton}
        </div>
        <DrawerSection
          actions={[
            <button
              aria-label="Add Workspace"
              className="secondary icon-button"
              key="add-workspace"
              type="button"
              onClick={onOpenWorkspaceModal}
            >
              +
            </button>,
          ]}
          id="left-workspaces"
          state={state}
          title="Workspaces"
          onToggleDrawerSection={onToggleDrawerSection}
        >
          <WorkspaceDrawerList
            busy={state.busy}
            selectedWorkspaceId={state.selectedWorkspaceId}
            workspaces={state.workspaces}
            onOpenSessionModal={onOpenSessionModal}
            onSelectWorkspace={onSelectWorkspace}
          />
        </DrawerSection>
        <DrawerSection
          actions={[
            <button
              aria-label="Refresh files"
              className="icon-button compact secondary"
              disabled={state.busy || !state.selectedWorkspaceId}
              key="refresh-files"
              title="Refresh files"
              type="button"
              onClick={onRefreshWorkspaceFiles}
            >
              ↻
            </button>,
          ]}
          id="left-files"
          state={state}
          title="Files"
          onToggleDrawerSection={onToggleDrawerSection}
        >
          <WorkspaceFileTree
            state={state}
            onSelectWorkspaceFile={onSelectWorkspaceFile}
            onToggleWorkspaceFileDir={onToggleWorkspaceFileDir}
          />
        </DrawerSection>
        <DrawerSection
          actions={[
            <button
              aria-label="Create session"
              className="icon-button compact"
              disabled={state.busy || !state.selectedWorkspaceId}
              key="create-session"
              title="Create session"
              type="button"
              onClick={onOpenSessionModal}
            >
              +
            </button>,
          ]}
          id="left-sessions"
          state={state}
          title="Sessions"
          onToggleDrawerSection={onToggleDrawerSection}
        >
          <DrawerSessionList
            state={state}
            onDeleteSession={onDeleteSession}
            onSelectSession={onSelectSession}
            onStopSession={onStopSession}
          />
        </DrawerSection>
      </div>
      <UserMenu state={state} onRefresh={onRefresh} onShowProfile={onShowProfile} onSignOut={onSignOut} />
    </aside>
  );
}
