import {Plus, X} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

export function WorkspaceModal({onClose, onCreateWorkspace}) {
  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="workspace-modal-title" aria-modal="true" className="modal-panel" role="dialog">
        <div className="modal-heading">
          <h2 id="workspace-modal-title">Create Workspace</h2>
          <Button aria-label="Close" icon={true} tooltip="Close" variant="secondary" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
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
          <Button type="submit">
            <Plus aria-hidden="true" />
            Create Workspace
          </Button>
        </form>
      </section>
    </ModalBackdrop>
  );
}
