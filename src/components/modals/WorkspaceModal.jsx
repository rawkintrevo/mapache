import {Plus, X} from "lucide-react";
import {useState} from "react";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

export function WorkspaceModal({onClose, onCreateWorkspace}) {
  const [sourceType, setSourceType] = useState("blank");
  const isGithub = sourceType === "github";

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
              source: {
                type: sourceType,
                repoUrl: formData.get("repoUrl"),
                requestedBranch: formData.get("branch"),
              },
              repoUrl: formData.get("repoUrl"),
              branch: formData.get("branch"),
            });
            onClose();
          }}
        >
          <label><span>Workspace Name</span><input autoComplete="off" name="name" placeholder="default" required /></label>
          <div className="workspace-source-choice">
            <label className="source-choice">
              <input
                checked={sourceType === "blank"}
                name="workspaceSource"
                type="radio"
                value="blank"
                onChange={() => setSourceType("blank")}
              />
              <span>Blank</span>
            </label>
            <label className="source-choice">
              <input
                checked={isGithub}
                name="workspaceSource"
                type="radio"
                value="github"
                onChange={() => setSourceType("github")}
              />
              <span>GitHub</span>
            </label>
          </div>
          {isGithub ? (
            <div className="workspace-source-fields">
              <label>
                <span>Repository URL</span>
                <input
                  autoComplete="off"
                  inputMode="url"
                  name="repoUrl"
                  placeholder="https://github.com/owner/repo"
                  required={isGithub}
                  type="url"
                />
              </label>
              <label>
                <span>Branch</span>
                <input autoComplete="off" name="branch" placeholder="default branch" />
              </label>
            </div>
          ) : null}
          <Button type="submit">
            <Plus aria-hidden="true" />
            Create Workspace
          </Button>
        </form>
      </section>
    </ModalBackdrop>
  );
}
