import "./ModalStack.css";
import {AuthModal} from "./AuthModal.jsx";
import {GenericEnvironmentModal} from "./GenericEnvironmentModal.jsx";
import {GoogleWorkspaceModal} from "./GoogleWorkspaceModal.jsx";
import {FileEditorDialog} from "./FileEditorDialog.jsx";
import {PullRequestModal} from "./PullRequestModal.jsx";
import {PiAuthManageModal} from "./PiAuthManageModal.jsx";
import {PiModelsModal} from "./PiModelsModal.jsx";
import {SessionModal} from "./SessionModal.jsx";
import {SessionEditModal} from "./SessionEditModal.jsx";
import {WorkspaceSubagentModal} from "./WorkspaceSubagentModal.jsx";
import {WorkspaceSkillModal} from "./WorkspaceSkillModal.jsx";
import {WorkspaceModal} from "./WorkspaceModal.jsx";
import {WorkspaceEditModal} from "./WorkspaceEditModal.jsx";
import {hasPendingOperations} from "../../state/pendingOperations.js";

export function ModalStack(props) {
  const {handlers, state} = props;
  const {files, git, github, google, modals, pi, sessions, workspaces} = handlers;
  const busy = hasPendingOperations(state.pendingOperations);
  const editingSession = state.sessions.find((session) => session.id === state.sessionEditModalSessionId);

  return (
    <>
      {editingSession ? (
        <SessionEditModal
          busy={busy}
          error={state.error}
          session={editingSession}
          onClose={modals.closeSessionEditModal}
          onSave={sessions.editSession}
        />
      ) : null}
      {state.sessionModalOpen ? (
        <SessionModal
          busy={busy}
          error={state.error}
          selectedWorkspace={props.selectedWorkspace}
          environmentEntries={state.piAuth.environmentEntries}
          onClose={modals.closeSessionModal}
          onCreateSession={sessions.createSession}
        />
      ) : null}
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
          onOpenModelsFile={files.openPiModelsFile}
          onSave={pi.saveSessionPiAuthSelection}
        />
      ) : null}
      {state.piModelsModalOpen ? (
        <PiModelsModal
          modelState={state.piModels}
          onClose={modals.closePiModelsModal}
          onRefresh={sessions.loadPiModels}
          onSave={sessions.savePiModelScope}
        />
      ) : null}
      {state.workspaceSkillModalOpen ? (
        <WorkspaceSkillModal
          selectedSession={props.selectedSession}
          workspaceSkills={state.workspaceSkills}
          onCancelWorkspaceSkillEdit={pi.cancelPiSkillEdit}
          onClose={modals.closeWorkspaceSkillModal}
          onDeleteWorkspaceSkill={pi.deletePiSkill}
          onEditWorkspaceSkill={pi.editPiSkill}
          onSaveWorkspaceSkill={pi.savePiSkill}
          onUpdateWorkspaceSkillForm={pi.updatePiSkillForm}
        />
      ) : null}
      {state.workspaceSubagentModalOpen ? (
        <WorkspaceSubagentModal
          selectedSession={props.selectedSession}
          workspaceSubagents={state.workspaceSubagents}
          onCancelWorkspaceSubagentEdit={pi.cancelWorkspaceSubagentEdit}
          onClose={modals.closeWorkspaceSubagentModal}
          onSaveWorkspaceSubagent={async () => {
            await pi.saveWorkspaceSubagent();
            if (!state.workspaceSubagents?.error) {
              modals.closeWorkspaceSubagentModal();
            }
          }}
          onUpdateWorkspaceSubagentForm={pi.updateWorkspaceSubagentForm}
        />
      ) : null}
      {state.fileEditor.open ? (
        <FileEditorDialog
          editor={state.fileEditor}
          onClose={files.closeFileEditor}
          onSave={files.saveFileEditor}
          onUpdateContent={files.updateFileEditorContent}
        />
      ) : null}
      {state.pullRequestForm.open ? (
        <PullRequestModal
          formState={state.pullRequestForm}
          onClose={git.closePullRequestModal}
          onSubmit={git.submitPullRequest}
          onUpdate={git.updatePullRequestForm}
        />
      ) : null}
    </>
  );
}
