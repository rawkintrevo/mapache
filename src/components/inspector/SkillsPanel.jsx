import {Edit3, Save, X} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {DrawerList} from "../drawers/DrawerList.jsx";
import {sessionSkillHarness, sessionSupportsWorkspaceSkills} from "../../utils/sessionSkills.js";
import {InspectorResourcePanel, InspectorResourceRow} from "./InspectorResourcePanel.jsx";

function stripFrontmatter(content) {
  return String(content || "").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function SkillRow({busy, skill, onDeleteWorkspaceSkill, onEditWorkspaceSkill}) {
  const detail = (
    <>
      <span className="drawer-list-row__code">{skill.path || skill.filePath || `<skill-path>`}</span>
      {skill.description ? <span className="subtle">{skill.description}</span> : null}
    </>
  );

  return (
    <InspectorResourceRow
      busy={busy}
      detail={detail}
      meta={skill.kind || "skill"}
      resource={skill}
      title={skill.name || "unnamed skill"}
      edit={{
        disabled: !onEditWorkspaceSkill,
        icon: <Edit3 aria-hidden="true" />,
        onClick: onEditWorkspaceSkill,
      }}
      onDelete={{
        disabled: !onDeleteWorkspaceSkill,
        label: `Delete ${skill.name}`,
        onClick: (item) => onDeleteWorkspaceSkill?.(item.name),
      }}
    />
  );
}

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

function SkillsBody({selectedSession, skills, status, onDeleteWorkspaceSkill, onEditWorkspaceSkill}) {
  const harness = sessionSkillHarness(selectedSession);
  if (!selectedSession) {
    return <p className="empty">Start or select an active Pi or Codex session to manage workspace-local skills.</p>;
  }
  if (!sessionSupportsWorkspaceSkills(selectedSession)) {
    return <p className="empty">Workspace skill management is available for Pi and Codex sessions only.</p>;
  }
  if (status.loading) {
    return <p className="empty">Loading workspace skills...</p>;
  }
  if (!skills.length) {
    return <p className="empty">No workspace skills yet. Skills created here are written to {harness?.examplePath || "/workspace/<skill-path>"}.</p>;
  }
  return (
    <DrawerList className="skill-list">
      {skills.map((skill) => (
        <SkillRow
          busy={status.saving}
          key={skill.path || skill.name}
          skill={skill}
          onDeleteWorkspaceSkill={onDeleteWorkspaceSkill}
          onEditWorkspaceSkill={onEditWorkspaceSkill}
        />
      ))}
    </DrawerList>
  );
}

export function SkillsPanel({
  workspaceSkills,
  selectedSession,
  state,
  onCancelWorkspaceSkillEdit,
  onDeleteWorkspaceSkill,
  onEditWorkspaceSkill,
  onOpenWorkspaceSkillModal,
  onRefreshWorkspaceSkills,
  onToggleDrawerSection,
}) {
  const harness = sessionSkillHarness(selectedSession);
  const status = workspaceSkills || {loading: false, saving: false, error: "", message: "", data: null, form: {}};
  const skills = status.data && Array.isArray(status.data.skills) ? status.data.skills : [];
  const canManageSkills = selectedSession && sessionSupportsWorkspaceSkills(selectedSession);

  return (
    <InspectorResourcePanel
      className="skills-panel"
      create={{
        disabled: !canManageSkills || !onOpenWorkspaceSkillModal,
        label: "New skill",
        onClick: () => {
          onCancelWorkspaceSkillEdit?.();
          onOpenWorkspaceSkillModal?.();
        },
      }}
      id="right-skills"
      description={harness ?
        `${harness.label} discovers Markdown skill files under ${harness.relativeSkillsPath}; ${harness.restartHint.charAt(0).toLowerCase()}${harness.restartHint.slice(1)}` :
        "Workspace-local skills for the active Pi or Codex harness."}
      refresh={{onClick: onRefreshWorkspaceSkills}}
      state={state}
      status={status}
      title="Skills"
      singularLabel="skill"
      onToggleDrawerSection={onToggleDrawerSection}
    >
      <SkillsBody
        selectedSession={selectedSession}
        skills={skills.map((skill) => ({...skill, contentBody: stripFrontmatter(skill.content)}))}
        status={status}
        onDeleteWorkspaceSkill={onDeleteWorkspaceSkill}
        onEditWorkspaceSkill={(skill) => {
          onEditWorkspaceSkill?.(skill);
          onOpenWorkspaceSkillModal?.();
        }}
      />
    </InspectorResourcePanel>
  );
}
