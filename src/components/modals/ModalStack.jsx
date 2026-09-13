import "./ModalStack.css";
import {AuthModal} from "./AuthModal.jsx";
import {GenericEnvironmentModal} from "./GenericEnvironmentModal.jsx";
import {GoogleWorkspaceModal} from "./GoogleWorkspaceModal.jsx";
import {McpServersModal} from "./McpServersModal.jsx";
import {PiAuthManageModal} from "./PiAuthManageModal.jsx";
import {WorkspaceModal} from "./WorkspaceModal.jsx";
import {WorkspaceEditModal} from "./WorkspaceEditModal.jsx";
import {hasPendingOperations} from "../../state/pendingOperations.js";

export function ModalStack(props) {
  const {handlers, state} = props;
  const {github, google, modals, pi, workspaces} = handlers;
  const busy = hasPendingOperations(state.pendingOperations);

  return (
    <>
      {state.workspaceModalOpen ? (
        <WorkspaceModal
          repoPicker={state.repoPicker}
          environmentEntries={state.piAuth.environmentEntries}
          onClose={modals.closeWorkspaceModal}
          onConnectGithub={github.connectGithub}
          onCreateWorkspace={(payload) => {
            workspaces.createWorkspace(payload);
            modals.closeWorkspaceModal();
          }}
          onLoadConnectedRepos={github.loadConnectedRepos}
        />
      ) : null}
      {state.workspaceEditModalOpen && props.selectedWorkspace ? (
        <WorkspaceEditModal
          busy={busy}
          error={state.error}
          workspace={props.selectedWorkspace}
          onClose={modals.closeWorkspaceEditModal}
          onSave={workspaces.renameWorkspace}
        />
      ) : null}
      {state.authModalOpen ? (
        <AuthModal
          piAuth={state.piAuth}
          onClose={modals.closeAuthModal}
          onSave={pi.savePiAuthProvider}
          onStartOpenAiCodexDeviceLogin={pi.startOpenAiCodexDeviceLogin}
          onUpdate={pi.updatePiAuthForm}
        />
      ) : null}
      {state.genericEnvironmentModalOpen ? <GenericEnvironmentModal piAuth={state.piAuth} selectedSession={props.selectedSession} onClose={modals.closeGenericEnvironmentModal} onSave={pi.saveGenericEnvironmentKey} onUpdate={pi.updateGenericEnvironmentForm} onEdit={pi.editGenericEnvironmentKey} onDelete={pi.deleteGenericEnvironmentKey} onToggleSelection={pi.updateGenericEnvironmentSelection} /> : null}
      {state.mcpServersModalOpen ? (
        <McpServersModal
          mcpServers={state.mcpServers}
          onClose={modals.closeMcpServersModal}
          onDelete={pi.deleteMcpServer}
          onEdit={pi.editMcpServer}
          onNew={pi.newMcpServer}
          onRefresh={pi.refreshMcpServers}
          onSave={pi.saveMcpServer}
          onUpdate={pi.updateMcpServerForm}
        />
      ) : null}
      {state.googleWorkspaceModalOpen ? (
        <GoogleWorkspaceModal
          googleWorkspace={state.googleWorkspace}
          onClose={modals.closeGoogleWorkspaceModal}
          onStartConnection={google.startConnection}
          onUpdateAccessLevel={google.updateAccessLevel}
          onUpdateService={google.updateService}
        />
      ) : null}
      {state.piAuthManageModalOpen ? (
        <PiAuthManageModal
          piAuth={state.piAuth}
          session={props.selectedSession}
          onAdd={() => modals.openAuthModal()}
          onClose={modals.closePiAuthManageModal}
          onDelete={pi.deletePiAuthProvider}
          onEdit={modals.openAuthModal}
          onSave={pi.saveSessionPiAuthSelection}
        />
      ) : null}
    </>
  );
}
