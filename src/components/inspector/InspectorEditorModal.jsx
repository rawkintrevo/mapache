import {Save, X} from "lucide-react";
import "../modals/ModalStack.css";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "../modals/ModalBackdrop.jsx";

export function InspectorEditorModal({
  children,
  description = null,
  error = "",
  message = "",
  onClose,
  onSubmit,
  saving = false,
  submitLabel = "Save",
  title,
}) {
  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="inspector-editor-modal-title" aria-modal="true" className="modal-panel inspector-editor-modal" role="dialog">
        <div className="modal-heading">
          <div>
            <h2 id="inspector-editor-modal-title">{title}</h2>
            {description ? <p className="subtle">{description}</p> : null}
          </div>
          <Button aria-label="Close" icon={true} title="Close" variant="secondary" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        {error ? <div className="error">{error}</div> : null}
        {message ? <p className="subtle">{message}</p> : null}
        <form
          className="modal-form inspector-editor-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit?.();
          }}
        >
          {children}
          <div className="modal-actions">
            <Button disabled={saving} type="submit">
              <Save aria-hidden="true" />
              {saving ? "Saving..." : submitLabel}
            </Button>
            <Button disabled={saving} type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      </section>
    </ModalBackdrop>
  );
}
