import {AdminPage} from "../admin/AdminPage.jsx";
import {LeftDrawer} from "../drawers/LeftDrawer.jsx";
import {RightDrawer} from "../inspector/RightDrawer.jsx";
import {ModalStack} from "../modals/ModalStack.jsx";
import {ProfilePage} from "../profile/ProfilePage.jsx";
import {WorkspacePanel} from "../workspaces/WorkspacePanel.jsx";
import {Topbar} from "./Topbar.jsx";

export function AppShell(props) {
  const {handlers, state} = props;
  const {admin, app, drawer, files, git, github, modals, pi, sessions, workspaces} = handlers;
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
      <Topbar state={state} onRefresh={app.refreshAll} onSignOut={app.signOut} />
      <main className={shellClassName}>
        <LeftDrawer
          state={state}
          onDeleteSession={sessions.deleteSession}
          onDeleteWorkspace={workspaces.deleteWorkspace}
          onOpenSessionModal={modals.openSessionModal}
          onOpenWorkspaceModal={modals.openWorkspaceModal}
          onRefresh={app.refreshAll}
          onRefreshWorkspaceFiles={files.refreshWorkspaceFiles}
          onDownloadWorkspaceFile={files.downloadWorkspaceFile}
          onUploadWorkspaceFiles={files.uploadWorkspaceFiles}
          onSelectSession={sessions.selectSession}
          onSelectWorkspace={workspaces.selectWorkspace}
          onShowProfile={modals.showProfile}
          onShowAdmin={admin.showAdmin}
          onSelectWorkspaceFile={files.selectWorkspaceFile}
          onSignOut={app.signOut}
          onStopSession={sessions.stopSession}
          onToggleDrawer={drawer.toggleDrawer}
          onToggleDrawerSection={drawer.toggleDrawerSection}
          onToggleWorkspaceFileDir={files.toggleWorkspaceFileDir}
        />
        {state.activePage === "admin" ? (
          <AdminPage
            state={state}
            onNextPage={admin.nextAdminUsersPage}
            onPreviousPage={admin.previousAdminUsersPage}
            onRefresh={admin.refreshAdminUsers}
            onSetWhitelisted={admin.setAdminUserWhitelisted}
          />
        ) : {state.activePage === "profile" ? (
          <ProfilePage
            state={state}
            onConnectGithub={github.connectGithub}
            onDisconnectGithub={github.disconnectGithub}
            onRefresh={app.refreshAll}
            onRefreshGithubRepositories={github.refreshGithubRepositories}
            onSignOut={app.signOut}
          />
        ) : (
          <WorkspacePanel
            selectedSession={selectedSession}
            selectedWorkspace={selectedWorkspace}
            state={state}
            onCommitGit={git.commitGit}
            onGetSessionAccessUrls={sessions.getSessionAccessUrls}
            onOpenPiAuthManage={modals.openPiAuthManageModal}
            onOpenPullRequest={git.openPullRequestModal}
            onPullGit={git.pullGit}
            onPushGit={git.pushGit}
            onResizeSession={sessions.resizeSession}
            onRestartSession={sessions.restartSession}
            onSelectSession={sessions.selectSession}
            onStageGitPath={git.stageGitPath}
            onUnstageGitPath={git.unstageGitPath}
            onUpdateGitCommitMessage={git.updateGitCommitMessage}
          />
        )}
        <RightDrawer
          selectedSession={selectedSession}
          state={state}
          onInstallPiPackage={pi.installPiPackage}
          onCancelPiSkillEdit={pi.cancelPiSkillEdit}
          onDeletePiAuthProvider={pi.deletePiAuthProvider}
          onDeletePiSkill={pi.deletePiSkill}
          onEditPiSkill={pi.editPiSkill}
          onOpenAuthModal={modals.openAuthModal}
          onOpenPiAuthManage={modals.openPiAuthManageModal}
          onRefreshPiAuth={pi.refreshPiAuth}
          onRefreshPiPackages={pi.refreshPiPackages}
          onRefreshPiSkills={pi.refreshPiSkills}
          onRemovePiPackage={pi.removePiPackage}
          onToggleDrawerSection={drawer.toggleDrawerSection}
          onToggleRightDrawer={drawer.toggleRightDrawer}
          onSavePiSkill={pi.savePiSkill}
          onUpdatePiInstallSource={pi.updatePiInstallSource}
          onUpdatePiPackage={pi.updatePiPackage}
          onUpdatePiSkillForm={pi.updatePiSkillForm}
        />
      </main>
      <ModalStack handlers={handlers} selectedSession={selectedSession} state={state} />
    </div>
  );
}
