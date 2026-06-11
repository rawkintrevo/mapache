import {ModalBackdrop} from "./ModalBackdrop.jsx";

export function WorkspaceModal({onClose, onCreateWorkspace}) {
  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="workspace-modal-title" aria-modal="true" className="modal-panel" role="dialog">
        <div className="modal-heading">
          <h2 id="workspace-modal-title">Create Workspace</h2>
          <button aria-label="Close" className="icon-button close-button secondary" type="button" onClick={onClose}>×</button>
        </div>
        <form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            onCreateWorkspace({
              name: formData.get("name"),
              source: formData.get("workspaceSource"),
              repoUrl: formData.get("repoUrl"),
              branch: formData.get("branch"),
            });
            onClose();
          }}
        >
          <label><span>Workspace Name</span><input autoComplete="off" name="name" placeholder="default" required /></label>
          <div className="workspace-source-choice">
            <label className="source-choice"><input defaultChecked name="workspaceSource" type="radio" value="blank" /><span>Blank</span></label>
            <label className="source-choice"><input name="workspaceSource" type="radio" value="github" /><span>GitHub</span></label>
          </div>
          <button className="primary" type="submit">Create Workspace</button>
        </form>
      </section>
    </ModalBackdrop>
  );
}
