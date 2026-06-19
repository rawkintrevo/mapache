import {X} from "lucide-react";
import {sessionSkillHarness} from "../../utils/sessionSkills.js";
import {Button} from "../common/Button.jsx";
import {SkillForm} from "../inspector/SkillsPanel.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

export function WorkspaceSkillModal({
  selectedSession,
  workspaceSkills,
  onCancelWorkspaceSkillEdit,
  onClose,
  onSaveWorkspaceSkill,
  onUpdateWorkspaceSkillForm,
}) {
  const status = workspaceSkills || {saving: false, error: "", form: {}};
  const form = status.form || {};
  const harness = sessionSkillHarness(selectedSession);
  const title = form.editing ? "Edit skill" : "New skill";
  const closeModal = () => {
    onCancelWorkspaceSkillEdit?.();
    onClose?.();
  };

  return (
    <ModalBackdrop onClose={closeModal}>
      <section aria-labelledby="workspace-skill-modal-title" aria-modal="true" className="modal-panel workspace-skill-panel" role="dialog">
        <div className="modal-heading">
          <div>
            <h2 id="workspace-skill-modal-title">{title}</h2>
            {harness ? <p className="subtle">Save Markdown skills under {harness.relativeSkillsPath} for {harness.label}.</p> : null}
          </div>
          <Button aria-label="Close" icon={true} tooltip="Close" variant="secondary" onClick={closeModal}>
            <X aria-hidden="true" />
          </Button>
        </div>
        {status.error ? <div className="error">{status.error}</div> : null}
        <SkillForm
          status={status}
          onCancelWorkspaceSkillEdit={closeModal}
          onSaveWorkspaceSkill={onSaveWorkspaceSkill}
          onUpdateWorkspaceSkillForm={onUpdateWorkspaceSkillForm}
        />
      </section>
    </ModalBackdrop>
  );
}
