import {lazy, Suspense} from "react";
import {LazySurfaceFallback} from "../common/LazySurfaceFallback.jsx";
import {LeftDrawer} from "../drawers/LeftDrawer.jsx";
import {RightDrawer} from "../inspector/RightDrawer.jsx";
import {WorkspacePanel} from "../workspaces/WorkspacePanel.jsx";
import {GlobalActionIndicator} from "./GlobalActionIndicator.jsx";
import {Topbar} from "./Topbar.jsx";

const AdminPage = lazy(() => import("../admin/AdminPage.jsx").then(({AdminPage: page}) => ({default: page})));
const ModalStack = lazy(() => import("../modals/ModalStack.jsx").then(({ModalStack: stack}) => ({default: stack})));
const ProfilePage = lazy(() => import("../profile/ProfilePage.jsx").then(({ProfilePage: page}) => ({default: page})));

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
  const hasOpenModal = state.authModalOpen ||
    state.fileEditor?.open ||
    state.genericEnvironmentModalOpen ||
    state.piAuthManageModalOpen ||
    state.pullRequestForm?.open ||
    state.sessionModalOpen ||
    state.workspaceModalOpen ||
    state.workspaceSkillModalOpen ||
    state.workspaceSubagentModalOpen;

  return (
    <div className="app">
      <Topbar state={state} onRefresh={app.refreshAll} onSignOut={app.signOut} />
      <GlobalActionIndicator busy={state.busy} message={state.busyMessage} />
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
          onCreateWorkspaceDirectory={files.createWorkspaceDirectory}
          onCreateWorkspaceFile={files.createWorkspaceFile}
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
          <Suspense fallback={<LazySurfaceFallback label="Loading admin..." />}>
            <AdminPage
              state={state}
              onNextPage={admin.nextAdminUsersPage}
              onPreviousPage={admin.previousAdminUsersPage}
              onRefresh={admin.refreshAdminUsers}
              onSetWhitelisted={admin.setAdminUserWhitelisted}
            />
          </Suspense>
        ) : state.activePage === "profile" ? (
          <Suspense fallback={<LazySurfaceFallback label="Loading profile..." />}>
            <ProfilePage
              state={state}
              onConnectGithub={github.connectGithub}
              onDisconnectGithub={github.disconnectGithub}
              onRefresh={app.refreshAll}
              onRefreshGithubRepositories={github.refreshGithubRepositories}
              onSignOut={app.signOut}
            />
          </Suspense>
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
            onShareSessionPreview={sessions.shareSessionPreview}
            onCloseSshSessionForward={sessions.closeSshSessionForward}
            onCreateSshSessionForward={sessions.createSshSessionForward}
            onSelectSession={sessions.selectSession}
            onStageGitPath={git.stageGitPath}
            onUnstageGitPath={git.unstageGitPath}
            onUpdateGitCommitMessage={git.updateGitCommitMessage}
            onUpdateSshForwardPort={sessions.updateSshForwardPort}
          />
        )}
        <RightDrawer
          selectedSession={selectedSession}
          state={state}
          onCancelWorkspaceSubagentEdit={pi.cancelWorkspaceSubagentEdit}
          onInstallPiPackage={pi.installPiPackage}
          onCancelPiSkillEdit={pi.cancelPiSkillEdit}
          onDeleteMcpServer={pi.deleteMcpServer}
          onDeletePiAuthProvider={pi.deletePiAuthProvider}
          onDeletePiSkill={pi.deletePiSkill}
          onDeleteWorkspaceSubagent={pi.deleteWorkspaceSubagent}
          onEditPiSkill={pi.editPiSkill}
          onEditWorkspaceSubagent={pi.editWorkspaceSubagent}
          onOpenAuthModal={modals.openAuthModal}
          onOpenPiAuthManage={modals.openPiAuthManageModal}
          onOpenGenericEnvironment={modals.openGenericEnvironmentModal}
          onOpenWorkspaceSkillModal={modals.openWorkspaceSkillModal}
          onOpenWorkspaceSubagentModal={modals.openWorkspaceSubagentModal}
          onRefreshMcpServers={pi.refreshMcpServers}
          onRefreshPiAuth={pi.refreshPiAuth}
          onRefreshPiPackages={pi.refreshPiPackages}
          onRefreshPiSkills={pi.refreshPiSkills}
          onRefreshWorkspaceSubagents={pi.refreshWorkspaceSubagents}
          onRemovePiPackage={pi.removePiPackage}
          onToggleDrawerSection={drawer.toggleDrawerSection}
          onToggleRightDrawer={drawer.toggleRightDrawer}
          onUpdateMcpServerForm={pi.updateMcpServerForm}
          onUpdatePiInstallSource={pi.updatePiInstallSource}
          onUpdatePiPackage={pi.updatePiPackage}
          onSaveMcpServer={pi.saveMcpServer}
        />
      </main>
      {hasOpenModal ? (
        <Suspense fallback={<LazySurfaceFallback label="Loading dialog..." />}>
          <ModalStack handlers={handlers} selectedSession={selectedSession} selectedWorkspace={selectedWorkspace} state={state} />
        </Suspense>
      ) : null}
    </div>
  );
}
