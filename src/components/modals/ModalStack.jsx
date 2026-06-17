import {AuthModal} from "./AuthModal.jsx";
import {FileEditorDialog} from "./FileEditorDialog.jsx";
import {PullRequestModal} from "./PullRequestModal.jsx";
import {PiAuthManageModal} from "./PiAuthManageModal.jsx";
import {SessionModal} from "./SessionModal.jsx";
import {WorkspaceModal} from "./WorkspaceModal.jsx";

export function ModalStack(props) {
  const {state} = props;

  return (
    <>
      {state.sessionModalOpen ? (
        <SessionModal
          busy={state.busy}
          error={state.error}
          onClose={props.onCloseSessionModal}
          onCreateSession={props.onCreateSession}
        />
      ) : null}
      {state.workspaceModalOpen ? (
        <WorkspaceModal
          repoPicker={state.repoPicker}
          onClose={props.onCloseWorkspaceModal}
          onConnectGithub={props.onConnectGithub}
          onCreateWorkspace={(payload) => {
            props.onCreateWorkspace(payload);
            props.onCloseWorkspaceModal();
          }}
          onLoadConnectedRepos={props.onLoadConnectedRepos}
        />
      ) : null}
      {state.authModalOpen ? (
        <AuthModal
          piAuth={state.piAuth}
          onClose={props.onCloseAuthModal}
          onSave={(provider, apiKey, entryLabel) => {
            props.onUpdatePiAuthForm({selectedProvider: provider, apiKey, entryLabel});
            props.onSavePiAuthProvider();
          }}
          onStartOpenAiCodexDeviceLogin={props.onStartOpenAiCodexDeviceLogin}
          onUpdate={props.onUpdatePiAuthForm}
        />
      ) : null}
      {state.piAuthManageModalOpen ? (
        <PiAuthManageModal
          piAuth={state.piAuth}
          session={props.selectedSession}
          onClose={props.onClosePiAuthManageModal}
          onSave={props.onSaveSessionPiAuthSelection}
        />
      ) : null}
      {state.fileEditor.open ? (
        <FileEditorDialog
          editor={state.fileEditor}
          onClose={props.onCloseFileEditor}
          onSave={props.onSaveFileEditor}
          onUpdateContent={props.onUpdateFileEditorContent}
        />
      ) : null}
      {state.pullRequestForm.open ? (
        <PullRequestModal
          formState={state.pullRequestForm}
          onClose={props.onClosePullRequest}
          onSubmit={props.onSubmitPullRequest}
          onUpdate={props.onUpdatePullRequestForm}
        />
      ) : null}
    </>
  );
}
