import {Edit3, RefreshCw, Save, Trash2, X} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {DrawerList, DrawerListActionButton, DrawerListItem} from "../drawers/DrawerList.jsx";
import {DrawerSection} from "../drawers/DrawerSection.jsx";

function stripFrontmatter(content) {
  return String(content || "").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function SkillRow({busy, skill, onDeletePiSkill, onEditPiSkill}) {
  const detail = (
    <>
      <span className="drawer-list-row__code">{skill.path || `.pi/skills/${skill.name}/SKILL.md`}</span>
      {skill.description ? <span className="subtle">{skill.description}</span> : null}
    </>
  );

  return (
    <DrawerListItem
      actions={[
        <DrawerListActionButton
          disabled={busy || !onEditPiSkill}
          icon={<Edit3 aria-hidden="true" />}
          key="edit"
          label={`Edit ${skill.name}`}
          onClick={() => onEditPiSkill?.(skill)}
        />,
        <DrawerListActionButton
          disabled={busy || !onDeletePiSkill}
          icon={<Trash2 aria-hidden="true" />}
          key="delete"
          label={`Delete ${skill.name}`}
          tone="danger"
          onClick={() => onDeletePiSkill?.(skill.name)}
        />,
      ]}
      detail={detail}
      meta={skill.kind || "skill"}
      title={skill.name || "unnamed skill"}
    />
  );
}

function SkillForm({status, onCancelPiSkillEdit, onSavePiSkill, onUpdatePiSkillForm}) {
  const form = status.form || {};
  return (
    <form
      className="skill-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSavePiSkill?.();
      }}
    >
      <label>
        Skill name
        <input
          autoComplete="off"
          disabled={status.saving || Boolean(form.editing)}
          placeholder="code-review"
          type="text"
          value={form.name || ""}
          onChange={(event) => onUpdatePiSkillForm?.({name: event.target.value})}
        />
      </label>
      <label>
        Description
        <input
          autoComplete="off"
          disabled={status.saving}
          placeholder="Use when reviewing code changes for correctness and maintainability."
          type="text"
          value={form.description || ""}
          onChange={(event) => onUpdatePiSkillForm?.({description: event.target.value})}
        />
      </label>
      <label>
        Markdown instructions
        <textarea
          disabled={status.saving}
          placeholder="# My Skill\n\nInstructions for pi..."
          rows={8}
          value={form.content || ""}
          onChange={(event) => onUpdatePiSkillForm?.({content: event.target.value})}
        />
      </label>
      <div className="skill-form-actions">
        <Button
          disabled={status.saving || !onSavePiSkill || !String(form.name || "").trim() || !String(form.description || "").trim() || !String(form.content || "").trim()}
          type="submit"
        >
          <Save aria-hidden="true" />
          {status.saving ? "Saving..." : form.editing ? "Save changes" : "Create skill"}
        </Button>
        {form.editing ? (
          <Button disabled={status.saving} type="button" variant="secondary" onClick={onCancelPiSkillEdit}>
            <X aria-hidden="true" />
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function SkillsBody({selectedSession, skills, status, onDeletePiSkill, onEditPiSkill}) {
  if (!selectedSession) {
    return <p className="empty">Start or select an active pi-basic session to manage workspace-local Pi skills.</p>;
  }
  if (status.loading) {
    return <p className="empty">Loading workspace skills...</p>;
  }
  if (status.error) {
    return <p className="empty">{status.error}</p>;
  }
  if (!skills.length) {
    return <p className="empty">No workspace skills yet. Skills created here are written to /workspace/.pi/skills/&lt;name&gt;/SKILL.md.</p>;
  }
  return (
    <DrawerList className="skill-list">
      {skills.map((skill) => (
        <SkillRow
          busy={status.saving}
          key={skill.path || skill.name}
          skill={skill}
          onDeletePiSkill={onDeletePiSkill}
          onEditPiSkill={onEditPiSkill}
        />
      ))}
    </DrawerList>
  );
}

export function SkillsPanel({
  piSkills,
  selectedSession,
  state,
  onCancelPiSkillEdit,
  onDeletePiSkill,
  onEditPiSkill,
  onRefreshPiSkills,
  onSavePiSkill,
  onToggleDrawerSection,
  onUpdatePiSkillForm,
}) {
  const status = piSkills || {loading: false, saving: false, error: "", message: "", data: null, form: {}};
  const skills = status.data && Array.isArray(status.data.skills) ? status.data.skills : [];

  return (
    <DrawerSection
      actions={[
        <Button
          aria-label="Refresh"
          disabled={status.loading || status.saving || !onRefreshPiSkills}
          icon={true}
          key="refresh-skills"
          size="compact"
          tooltip="Refresh"
          variant="secondary"
          onClick={onRefreshPiSkills}
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
        Workspace-local Pi skills. Pi discovers Markdown skill files under .pi/skills; restart Pi in the terminal if a running agent needs to rescan them.
      </p>
      {selectedSession ? (
        <SkillForm
          status={status}
          onCancelPiSkillEdit={onCancelPiSkillEdit}
          onSavePiSkill={onSavePiSkill}
          onUpdatePiSkillForm={onUpdatePiSkillForm}
        />
      ) : null}
      {status.message ? <p className="subtle">{status.message}</p> : null}
      <SkillsBody
        selectedSession={selectedSession}
        skills={skills.map((skill) => ({...skill, contentBody: stripFrontmatter(skill.content)}))}
        status={status}
        onDeletePiSkill={onDeletePiSkill}
        onEditPiSkill={onEditPiSkill}
      />
    </DrawerSection>
  );
}
