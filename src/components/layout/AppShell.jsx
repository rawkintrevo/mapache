import {LeftDrawer} from "../drawers/LeftDrawer.jsx";
import {RightDrawer} from "../inspector/RightDrawer.jsx";
import {ModalStack} from "../modals/ModalStack.jsx";
import {ProfilePage} from "../profile/ProfilePage.jsx";
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
          onDeleteWorkspace={props.onDeleteWorkspace}
          onOpenSessionModal={props.onOpenSessionModal}
          onOpenWorkspaceModal={props.onOpenWorkspaceModal}
          onRefresh={props.onRefresh}
          onRefreshWorkspaceFiles={props.onRefreshWorkspaceFiles}
          onDownloadWorkspaceFile={props.onDownloadWorkspaceFile}
          onUploadWorkspaceFiles={props.onUploadWorkspaceFiles}
          onSelectSession={props.onSelectSession}
          onSelectWorkspace={props.onSelectWorkspace}
          onShowProfile={props.onShowProfile}
          onSelectWorkspaceFile={props.onSelectWorkspaceFile}
          onSignOut={props.onSignOut}
          onStopSession={props.onStopSession}
          onToggleDrawer={props.onToggleDrawer}
          onToggleDrawerSection={props.onToggleDrawerSection}
          onToggleWorkspaceFileDir={props.onToggleWorkspaceFileDir}
        />
        {state.activePage === "profile" ? (
          <ProfilePage state={state} onRefresh={props.onRefresh} onSignOut={props.onSignOut} />
        ) : (
          <WorkspacePanel
            selectedSession={selectedSession}
            selectedWorkspace={selectedWorkspace}
            state={state}
            onCommitGit={props.onCommitGit}
            onGetSessionAccessUrls={props.onGetSessionAccessUrls}
            onOpenPullRequest={props.onOpenPullRequest}
            onPullGit={props.onPullGit}
            onPushGit={props.onPushGit}
            onResizeSession={props.onResizeSession}
            onRestartSession={props.onRestartSession}
            onSelectSession={props.onSelectSession}
            onStageGitPath={props.onStageGitPath}
            onUnstageGitPath={props.onUnstageGitPath}
            onUpdateGitCommitMessage={props.onUpdateGitCommitMessage}
          />
        )}
        <RightDrawer
          selectedSession={selectedSession}
          state={state}
          onInstallPiPackage={props.onInstallPiPackage}
          onCancelPiSkillEdit={props.onCancelPiSkillEdit}
          onDeletePiAuthProvider={props.onDeletePiAuthProvider}
          onDeletePiSkill={props.onDeletePiSkill}
          onEditPiSkill={props.onEditPiSkill}
          onOpenAuthModal={props.onOpenAuthModal}
          onOpenPiAuthManage={props.onOpenPiAuthManage}
          onRefreshPiAuth={props.onRefreshPiAuth}
          onRefreshPiPackages={props.onRefreshPiPackages}
          onRefreshPiSkills={props.onRefreshPiSkills}
          onRemovePiPackage={props.onRemovePiPackage}
          onToggleDrawerSection={props.onToggleDrawerSection}
          onToggleRightDrawer={props.onToggleRightDrawer}
          onSavePiSkill={props.onSavePiSkill}
          onUpdatePiInstallSource={props.onUpdatePiInstallSource}
          onUpdatePiPackage={props.onUpdatePiPackage}
          onUpdatePiSkillForm={props.onUpdatePiSkillForm}
        />
      </main>
      <ModalStack {...props} selectedSession={selectedSession} />
    </div>
  );
}
