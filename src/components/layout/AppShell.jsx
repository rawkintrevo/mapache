import {LeftDrawer} from "../drawers/LeftDrawer.jsx";
import {RightDrawer} from "../inspector/RightDrawer.jsx";
import {ModalStack} from "../modals/ModalStack.jsx";
import {WorkspacePanel} from "../workspaces/WorkspacePanel.jsx";
import {Topbar} from "./Topbar.jsx";

export function AppShell(props) {
  const {state} = props;
  const selectedWorkspace = state.workspaces.find(
      (workspace) => workspace.id === state.selectedWorkspaceId,
  );
  const selectedSession = state.sessions.find(
      (session) => session.id === state.selectedSessionId,
  );
  const shellClassName = [
    state.drawerCollapsed ? "drawer-collapsed" : "",
    state.rightDrawerCollapsed ? "right-drawer-collapsed" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className="app">
      <Topbar state={state} onRefresh={props.onRefresh} onSignOut={props.onSignOut} />
      <main className={shellClassName}>
        <LeftDrawer
          state={state}
          onDeleteSession={props.onDeleteSession}
          onOpenSessionModal={props.onOpenSessionModal}
          onOpenWorkspaceModal={props.onOpenWorkspaceModal}
          onRefreshWorkspaceFiles={props.onRefreshWorkspaceFiles}
          onSelectSession={props.onSelectSession}
          onSelectWorkspace={props.onSelectWorkspace}
          onSelectWorkspaceFile={props.onSelectWorkspaceFile}
          onStopSession={props.onStopSession}
          onToggleDrawer={props.onToggleDrawer}
          onToggleDrawerSection={props.onToggleDrawerSection}
          onToggleWorkspaceFileDir={props.onToggleWorkspaceFileDir}
        />
        <WorkspacePanel
          selectedSession={selectedSession}
          selectedWorkspace={selectedWorkspace}
          state={state}
          onResizeSession={props.onResizeSession}
          onRestartSession={props.onRestartSession}
          onSelectSession={props.onSelectSession}
        />
        <RightDrawer
          selectedSession={selectedSession}
          state={state}
          onInstallPiPackage={props.onInstallPiPackage}
          onDeletePiAuthProvider={props.onDeletePiAuthProvider}
          onOpenAuthModal={props.onOpenAuthModal}
          onRefreshPiAuth={props.onRefreshPiAuth}
          onRefreshPiPackages={props.onRefreshPiPackages}
          onRemovePiPackage={props.onRemovePiPackage}
          onToggleDrawerSection={props.onToggleDrawerSection}
          onToggleRightDrawer={props.onToggleRightDrawer}
          onUpdatePiInstallSource={props.onUpdatePiInstallSource}
          onUpdatePiPackage={props.onUpdatePiPackage}
        />
      </main>
      <ModalStack {...props} />
    </div>
  );
}
