import {BookOpen, Save, X} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {sessionSkillHarness, sessionSupportsWorkspaceSkills} from "../../utils/sessionSkills.js";
import {InspectorResourcePanel} from "./InspectorResourcePanel.jsx";

export function SkillForm({status, onCancelWorkspaceSkillEdit, onSaveWorkspaceSkill, onUpdateWorkspaceSkillForm}) {
  const form = status.form || {};
  return (
    <form
      className="skill-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSaveWorkspaceSkill?.();
      }}
    >
      <label>
        Skill name
        <input
          autoComplete="off"
          disabled={status.saving || Boolean(form.editing)}
          id="workspace-skill-name"
          name="name"
          placeholder="code-review"
          type="text"
          value={form.name || ""}
          onChange={(event) => onUpdateWorkspaceSkillForm?.({name: event.target.value})}
        />
      </label>
      <label>
        Description
        <input
          autoComplete="off"
          disabled={status.saving}
          id="workspace-skill-description"
          name="description"
          placeholder="Use when reviewing code changes for correctness and maintainability."
          type="text"
          value={form.description || ""}
          onChange={(event) => onUpdateWorkspaceSkillForm?.({description: event.target.value})}
        />
      </label>
      <label>
        Markdown instructions
        <textarea
          disabled={status.saving}
          id="workspace-skill-content"
          name="content"
          placeholder="# My Skill\n\nInstructions for the active agent..."
          rows={8}
          value={form.content || ""}
          onChange={(event) => onUpdateWorkspaceSkillForm?.({content: event.target.value})}
        />
      </label>
      <div className="skill-form-actions">
        <Button
          disabled={status.saving || !onSaveWorkspaceSkill || !String(form.name || "").trim() || !String(form.description || "").trim() || !String(form.content || "").trim()}
          type="submit"
        >
          <Save aria-hidden="true" />
          {status.saving ? "Saving..." : form.editing ? "Save changes" : "Create skill"}
        </Button>
        {form.editing ? (
          <Button disabled={status.saving} type="button" variant="secondary" onClick={onCancelWorkspaceSkillEdit}>
            <X aria-hidden="true" />
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function SkillsPanel({
  workspaceSkills,
  selectedSession,
  state,
  onCancelWorkspaceSkillEdit,
  onOpenWorkspaceSkillModal,
  onRefreshWorkspaceSkills,
  onToggleDrawerSection,
}) {
  const harness = sessionSkillHarness(selectedSession);
  const status = workspaceSkills || {loading: false, saving: false, error: "", message: "", data: null, form: {}};
  const canManageSkills = selectedSession && sessionSupportsWorkspaceSkills(selectedSession);

  return (
    <InspectorResourcePanel
      className="skills-panel"
      id="right-skills"
      description={harness ?
        `Inspect the Markdown skills discovered by ${harness.label}.` :
        "Discovered skills for the active Pi or Codex harness."}
      refresh={{onClick: onRefreshWorkspaceSkills}}
      state={state}
      status={status}
      title="Skills"
      singularLabel="skill"
      onToggleDrawerSection={onToggleDrawerSection}
    >
      <Button
        className="auth-center-manage"
        disabled={!canManageSkills || status.loading || status.saving || !onOpenWorkspaceSkillModal}
        variant="secondary"
        onClick={() => {
          onCancelWorkspaceSkillEdit?.();
          onOpenWorkspaceSkillModal?.();
        }}
      >
        <BookOpen aria-hidden="true" />
        Manage skills
      </Button>
      {!selectedSession ? <p className="empty">Start or select an active Pi or Codex session to inspect skills.</p> : null}
      {selectedSession && !canManageSkills ? <p className="empty">Skill management is available for Pi and Codex sessions only.</p> : null}
    </InspectorResourcePanel>
  );
}
