import "./ModalStack.css";
import {AuthModal} from "./AuthModal.jsx";
import {FileEditorDialog} from "./FileEditorDialog.jsx";
import {PullRequestModal} from "./PullRequestModal.jsx";
import {PiAuthManageModal} from "./PiAuthManageModal.jsx";
import {SessionModal} from "./SessionModal.jsx";
import {WorkspaceSubagentModal} from "./WorkspaceSubagentModal.jsx";
import {WorkspaceSkillModal} from "./WorkspaceSkillModal.jsx";
import {WorkspaceModal} from "./WorkspaceModal.jsx";

export function ModalStack(props) {
  const {handlers, state} = props;
  const {files, git, github, modals, pi, sessions, workspaces} = handlers;

  return (
    <>
      {state.sessionModalOpen ? (
        <SessionModal
          busy={state.busy}
          error={state.error}
          selectedWorkspace={props.selectedWorkspace}
          onClose={modals.closeSessionModal}
          onCreateSession={sessions.createSession}
        />
      ) : null}
      {state.workspaceModalOpen ? (
        <WorkspaceModal
          repoPicker={state.repoPicker}
          onClose={modals.closeWorkspaceModal}
          onConnectGithub={github.connectGithub}
          onCreateWorkspace={(payload) => {
            workspaces.createWorkspace(payload);
            modals.closeWorkspaceModal();
          }}
          onLoadConnectedRepos={github.loadConnectedRepos}
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
      {state.piAuthManageModalOpen ? (
        <PiAuthManageModal
          piAuth={state.piAuth}
          session={props.selectedSession}
          onClose={modals.closePiAuthManageModal}
          onSave={pi.saveSessionPiAuthSelection}
        />
      ) : null}
      {state.workspaceSkillModalOpen ? (
        <WorkspaceSkillModal
          selectedSession={props.selectedSession}
          workspaceSkills={state.workspaceSkills}
          onCancelWorkspaceSkillEdit={pi.cancelPiSkillEdit}
          onClose={modals.closeWorkspaceSkillModal}
          onSaveWorkspaceSkill={async () => {
            await pi.savePiSkill();
            if (!state.workspaceSkills?.error) {
              modals.closeWorkspaceSkillModal();
            }
          }}
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
