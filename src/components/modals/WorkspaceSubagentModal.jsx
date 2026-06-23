import {X} from "lucide-react";
import {sessionSubagentHarness} from "../../utils/sessionHarnesses.js";
import {Button} from "../common/Button.jsx";
import {SubagentForm} from "../inspector/SubagentsPanel.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

export function WorkspaceSubagentModal({
  selectedSession,
  workspaceSubagents,
  onCancelWorkspaceSubagentEdit,
  onClose,
  onSaveWorkspaceSubagent,
  onUpdateWorkspaceSubagentForm,
}) {
  const status = workspaceSubagents || {saving: false, error: "", form: {}};
  const form = status.form || {};
  const harness = sessionSubagentHarness(selectedSession);
  const title = form.editing ? "Edit subagent" : "New subagent";
  const closeModal = () => {
    onCancelWorkspaceSubagentEdit?.();
    onClose?.();
  };

  return (
    <ModalBackdrop onClose={closeModal}>
      <section aria-labelledby="workspace-subagent-modal-title" aria-modal="true" className="modal-panel workspace-skill-panel" role="dialog">
        <div className="modal-heading">
          <div>
            <h2 id="workspace-subagent-modal-title">{title}</h2>
            {harness ? <p className="subtle">Save project subagents under {harness.relativePath} for {harness.label}.</p> : null}
          </div>
          <Button aria-label="Close" icon={true} tooltip="Close" variant="secondary" onClick={closeModal}>
            <X aria-hidden="true" />
          </Button>
        </div>
        {status.error ? <div className="error">{status.error}</div> : null}
        <SubagentForm
          status={status}
          onCancelWorkspaceSubagentEdit={closeModal}
          onSaveWorkspaceSubagent={onSaveWorkspaceSubagent}
          onUpdateWorkspaceSubagentForm={onUpdateWorkspaceSubagentForm}
        />
      </section>
    </ModalBackdrop>
  );
}
