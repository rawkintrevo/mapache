import {useState} from "react";
import {Pencil, Plus, Trash2, X} from "lucide-react";
import {sessionSkillHarness} from "../../utils/sessionSkills.js";
import {Button} from "../common/Button.jsx";
import {SkillForm} from "../inspector/SkillsPanel.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

export function WorkspaceSkillModal({
  selectedSession,
  workspaceSkills,
  onCancelWorkspaceSkillEdit,
  onClose,
  onDeleteWorkspaceSkill,
  onEditWorkspaceSkill,
  onSaveWorkspaceSkill,
  onUpdateWorkspaceSkillForm,
}) {
  const status = workspaceSkills || {saving: false, error: "", form: {}};
  const form = status.form || {};
  const harness = sessionSkillHarness(selectedSession);
  const skills = status.data && Array.isArray(status.data.skills) ? status.data.skills : [];
  const [editing, setEditing] = useState(Boolean(form.editing));
  const title = editing ? (form.editing ? "Edit skill" : "New skill") : "Manage skills";
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
            {harness ? <p className="subtle">Skills discovered by {harness.label}; new skills are saved under {harness.relativeSkillsPath}.</p> : null}
          </div>
          <Button aria-label="Close" icon={true} tooltip="Close" variant="secondary" onClick={closeModal}>
            <X aria-hidden="true" />
          </Button>
        </div>
        {status.error ? <div className="error">{status.error}</div> : null}
        {editing ? (
          <SkillForm
            status={status}
            onCancelWorkspaceSkillEdit={() => {
              onCancelWorkspaceSkillEdit?.();
              setEditing(false);
            }}
            onSaveWorkspaceSkill={async () => {
              if (await onSaveWorkspaceSkill?.()) setEditing(false);
            }}
            onUpdateWorkspaceSkillForm={onUpdateWorkspaceSkillForm}
          />
        ) : (
          <>
            <Button
              className="pi-auth-add"
              disabled={status.loading || status.saving}
              variant="secondary"
              onClick={() => {
                onCancelWorkspaceSkillEdit?.();
                setEditing(true);
              }}
            >
              <Plus aria-hidden="true" />
              Add skill
            </Button>
            {status.loading ? <p className="empty">Loading discovered skills...</p> : null}
            {!status.loading && skills.length ? (
              <div className="pi-auth-selection-list workspace-skill-selection-list">
                {skills.map((skill) => (
                  <div className="pi-auth-selection-row" key={skill.path || skill.name}>
                    <label className="checkbox-label" title={`${skill.name} is discovered by ${harness?.label || "the active harness"}`}>
                      <input aria-label={`${skill.name} is discovered`} checked={skill.discovered !== false} disabled readOnly type="checkbox" />
                      <span>
                        <strong>{skill.name || "Unnamed skill"}</strong>
                        <small>{skill.description || skill.path}</small>
                        {skill.description ? <small className="drawer-list-row__code">{skill.path}</small> : null}
                      </span>
                    </label>
                    <div className="pi-auth-selection-row__actions">
                      <Button
                        aria-label={`Edit ${skill.name}`}
                        disabled={status.saving || !skill.editable}
                        icon={true}
                        tooltip={skill.editable ? "Edit" : "User and alternate-root skills are read-only here"}
                        variant="secondary"
                        onClick={() => {
                          onEditWorkspaceSkill?.(skill);
                          setEditing(true);
                        }}
                      ><Pencil aria-hidden="true" /></Button>
                      <Button
                        aria-label={`Delete ${skill.name}`}
                        disabled={status.saving || !skill.editable}
                        icon={true}
                        tooltip={skill.editable ? "Delete" : "User and alternate-root skills are read-only here"}
                        variant="secondary"
                        onClick={() => onDeleteWorkspaceSkill?.(skill.name)}
                      ><Trash2 aria-hidden="true" /></Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {!status.loading && !skills.length ? <p className="empty">No skills were found in the local project or user skill directories.</p> : null}
          </>
        )}
      </section>
    </ModalBackdrop>
  );
}
