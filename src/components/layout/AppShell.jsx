import {lazy, Suspense, useEffect, useState} from "react";
import {LazySurfaceFallback} from "../common/LazySurfaceFallback.jsx";
import {WorkspacePanel} from "../workspaces/WorkspacePanel.jsx";
import {hasPendingOperations, getPendingOperationMessage} from "../../state/pendingOperations.js";
import {GlobalActionIndicator} from "./GlobalActionIndicator.jsx";
import {Topbar} from "./Topbar.jsx";
import {isMarkedRuntimeSession} from "../sessions/sessionPresentation.js";
import {useResourceMetrics} from "../sessions/useResourceMetrics.js";
import {useSessionAccessUrls} from "../sessions/useSessionAccessUrls.js";
import {deriveResourceMetricsSocketUrl} from "../../utils/resourceMetrics.js";
import {SessionLogsModal} from "../modals/SessionLogsModal.jsx";

const AdminPage = lazy(() => import("../admin/AdminPage.jsx").then(({AdminPage: page}) => ({default: page})));
const ModalStack = lazy(() => import("../modals/ModalStack.jsx").then(({ModalStack: stack}) => ({default: stack})));
const ProfilePage = lazy(() => import("../profile/ProfilePage.jsx").then(({ProfilePage: page}) => ({default: page})));

export function AppShell(props) {
  const {handlers, state} = props;
  const {admin, app, github, modals, sessions, workspaces} = handlers;
  const selectedWorkspace = state.workspaces.find(
      (workspace) => workspace.id === state.selectedWorkspaceId,
  );
  const selectedSession = selectedWorkspace ? state.sessions.find(
    (session) => session.id === selectedWorkspace.canonicalSessionId,
  ) || state.sessions.find(
    (session) => session.id === state.selectedSessionId,
  ) || state.sessions[0] : null;
  const [activeCanvas, setActiveCanvas] = useState(() => (
    isMarkedRuntimeSession(selectedSession) ? "agent" : "terminal"
  ));
  const [logsOpen, setLogsOpen] = useState(false);
  const selectedSessionIsManaged = isMarkedRuntimeSession(selectedSession);
  const selectedWorkspaceIsSsh = selectedWorkspace?.source?.type === "ssh";
  const hasRunnerUrl = Boolean(selectedSession?.serviceUrl);
  const access = useSessionAccessUrls({
    enabled: Boolean(selectedSession && hasRunnerUrl && !selectedWorkspaceIsSsh && ["running", "ready"].includes(selectedSession.status)),
    workspaceId: selectedWorkspace?.id || "",
    sessionId: selectedSession?.id || "",
    serviceUrl: selectedSession?.serviceUrl || "",
    loadAccessUrls: sessions.getSessionAccessUrls,
  });
  const metricsSocketUrl = deriveResourceMetricsSocketUrl(access.accessUrls?.terminalUrl);
  const metrics = useResourceMetrics({
    enabled: Boolean(selectedSession && !selectedWorkspaceIsSsh && selectedSession.status === "running" && metricsSocketUrl),
    sessionId: selectedSession?.id || "",
    socketUrl: metricsSocketUrl || "",
  });

  useEffect(() => {
    setActiveCanvas(selectedSessionIsManaged ? "agent" : "terminal");
    setLogsOpen(false);
  }, [selectedSession?.id, selectedSessionIsManaged, selectedWorkspace?.id]);
  const busy = hasPendingOperations(state.pendingOperations);
  const hasOpenModal = state.authModalOpen ||
    state.genericEnvironmentModalOpen ||
    state.mcpServersModalOpen ||
    state.googleWorkspaceManageModalOpen ||
    state.googleWorkspaceModalOpen ||
    state.piAuthManageModalOpen ||
    state.workspaceEditModalOpen ||
    state.workspaceModalOpen;

  return (
    <div className="app">
      <Topbar
        activeCanvas={activeCanvas}
        state={state}
        selectedSession={selectedSession}
        onDeleteWorkspace={workspaces.deleteWorkspace}
        onOpenGenericEnvironment={modals.openGenericEnvironmentModal}
        onOpenGoogleWorkspace={modals.openGoogleWorkspaceManageModal}
        onOpenMcpServers={modals.openMcpServersModal}
        onOpenPiAuthManage={modals.openPiAuthManageModal}
        onOpenWorkspaceEditModal={modals.openWorkspaceEditModal}
        onOpenWorkspaceModal={modals.openWorkspaceModal}
        onRefresh={app.refreshAll}
        onSelectCanvas={setActiveCanvas}
        onSelectWorkspace={workspaces.selectWorkspace}
        onShowAdmin={admin.showAdmin}
        onShowLogs={() => setLogsOpen(true)}
        onShowProfile={modals.showProfile}
        onSignOut={app.signOut}
        onSetSessionLongRunning={sessions.setSessionLongRunning}
        onToggleWorkspace={workspaces.toggleWorkspace}
        resourceMetrics={selectedSession && !selectedWorkspaceIsSsh && selectedSession.status === "running" ? metrics : null}
      />
      <GlobalActionIndicator busy={busy} message={getPendingOperationMessage(state.pendingOperations)} />
      <main>
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
            activeCanvas={activeCanvas}
            selectedSession={selectedSession}
            selectedWorkspace={selectedWorkspace}
            state={state}
            access={access}
            onSelectCanvas={setActiveCanvas}
          />
        )}
      </main>
      {hasOpenModal ? (
        <Suspense fallback={<LazySurfaceFallback label="Loading dialog..." />}>
          <ModalStack handlers={handlers} selectedSession={selectedSession} selectedWorkspace={selectedWorkspace} state={state} />
        </Suspense>
      ) : null}
      {logsOpen && selectedSession && selectedWorkspace ? (
        <SessionLogsModal
          session={selectedSession}
          workspaceId={selectedWorkspace.id}
          onClose={() => setLogsOpen(false)}
          onLoadLogs={sessions.getSessionLogs}
        />
      ) : null}
    </div>
  );
}
