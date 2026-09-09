import {Save, X} from "lucide-react";
import {useEffect, useState} from "react";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

export function WorkspaceEditModal({busy, error = "", workspace, onClose, onSave}) {
  const [name, setName] = useState(workspace.name || "");

  useEffect(() => {
    setName(workspace.name || "");
  }, [workspace.id, workspace.name]);

  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="workspace-edit-modal-title" aria-modal="true" className="modal-panel" role="dialog">
        <div className="modal-heading">
          <h2 id="workspace-edit-modal-title">Edit workspace</h2>
          <Button aria-label="Close" icon={true} tooltip="Close" variant="secondary" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        {error ? <div className="error">{error}</div> : null}
        <form
          className="modal-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const saved = await onSave(workspace.id, name.trim());
            if (saved) onClose();
          }}
        >
          <label>
            <span>Name</span>
            <input
              autoComplete="off"
              autoFocus
              maxLength={256}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="modal-form-actions">
            <Button disabled={busy || !name.trim()} type="submit">
              <Save aria-hidden="true" />
              Save changes
            </Button>
            <Button disabled={busy} type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      </section>
    </ModalBackdrop>
  );
}
