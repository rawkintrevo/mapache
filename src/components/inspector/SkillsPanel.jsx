import {Edit3, Plus, RefreshCw, Save, Trash2, X} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {DrawerList, DrawerListActionButton, DrawerListItem} from "../drawers/DrawerList.jsx";
import {DrawerSection} from "../drawers/DrawerSection.jsx";
import {sessionSkillHarness, sessionSupportsWorkspaceSkills} from "../../utils/sessionSkills.js";

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
    <DrawerListItem
      actions={[
        <DrawerListActionButton
          disabled={busy || !onEditWorkspaceSkill}
          icon={<Edit3 aria-hidden="true" />}
          key="edit"
          label={`Edit ${skill.name}`}
          onClick={() => onEditWorkspaceSkill?.(skill)}
        />,
        <DrawerListActionButton
          disabled={busy || !onDeleteWorkspaceSkill}
          icon={<Trash2 aria-hidden="true" />}
          key="delete"
          label={`Delete ${skill.name}`}
          tone="danger"
          onClick={() => onDeleteWorkspaceSkill?.(skill.name)}
        />,
      ]}
      detail={detail}
      meta={skill.kind || "skill"}
      title={skill.name || "unnamed skill"}
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
  if (status.error) {
    return <p className="empty">{status.error}</p>;
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
    <DrawerSection
      actions={[
        <Button
          aria-label="New skill"
          disabled={status.loading || status.saving || !canManageSkills || !onOpenWorkspaceSkillModal}
          icon={true}
          key="new-skill"
          size="compact"
          title="New skill"
          tooltip="New skill"
          variant="secondary"
          onClick={() => {
            onCancelWorkspaceSkillEdit?.();
            onOpenWorkspaceSkillModal?.();
          }}
        >
          <Plus aria-hidden="true" />
        </Button>,
        <Button
          aria-label="Refresh"
          disabled={status.loading || status.saving || !onRefreshWorkspaceSkills}
          icon={true}
          key="refresh-skills"
          size="compact"
          tooltip="Refresh"
          variant="secondary"
          onClick={onRefreshWorkspaceSkills}
        >
          <RefreshCw aria-hidden="true" />
        </Button>,
      ]}
      className="skills-panel"
      id="right-skills"
      state={state}
      title="Skills"
      onToggleDrawerSection={onToggleDrawerSection}
    >
      <p className="subtle">
        {harness ?
          `${harness.label} discovers Markdown skill files under ${harness.relativeSkillsPath}; ${harness.restartHint.charAt(0).toLowerCase()}${harness.restartHint.slice(1)}` :
          "Workspace-local skills for the active Pi or Codex harness."}
      </p>
      {status.message ? <p className="subtle">{status.message}</p> : null}
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
    </DrawerSection>
  );
}
