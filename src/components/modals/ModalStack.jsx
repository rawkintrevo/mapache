import {AuthModal} from "./AuthModal.jsx";
import {FileEditorDialog} from "./FileEditorDialog.jsx";
import {PullRequestModal} from "./PullRequestModal.jsx";
import {SessionModal} from "./SessionModal.jsx";
import {WorkspaceModal} from "./WorkspaceModal.jsx";

export function ModalStack(props) {
  const {state} = props;

  return (
    <>
      {state.sessionModalOpen ? (
        <SessionModal busy={state.busy} onClose={props.onCloseSessionModal} onCreateSession={props.onCreateSession} />
      ) : null}
      {state.workspaceModalOpen ? (
        <WorkspaceModal
          onClose={props.onCloseWorkspaceModal}
          onCreateWorkspace={(payload) => {
            props.onCreateWorkspace(payload);
            props.onCloseWorkspaceModal();
          }}
        />
      ) : null}
      {state.authModalOpen ? (
        <AuthModal
          onClose={props.onCloseAuthModal}
          onSave={(provider, apiKey) => {
            props.onUpdatePiAuthForm({selectedProvider: provider, apiKey});
            props.onSavePiAuthProvider();
          }}
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
