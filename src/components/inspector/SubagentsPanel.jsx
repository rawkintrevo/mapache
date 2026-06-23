import {Edit3, Plus, RefreshCw, Save, Trash2, X} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {DrawerList, DrawerListActionButton, DrawerListItem} from "../drawers/DrawerList.jsx";
import {DrawerSection} from "../drawers/DrawerSection.jsx";
import {sessionSubagentHarness, sessionSupportsSubagents} from "../../utils/sessionHarnesses.js";

function SubagentRow({busy, subagent, onDeleteWorkspaceSubagent, onEditWorkspaceSubagent}) {
  const detail = (
    <>
      <span className="drawer-list-row__code">{subagent.path || "<subagent-path>"}</span>
      {subagent.description ? <span className="subtle">{subagent.description}</span> : null}
    </>
  );

  return (
    <DrawerListItem
      actions={[
        <DrawerListActionButton
          disabled={busy || !onEditWorkspaceSubagent}
          icon={<Edit3 aria-hidden="true" />}
          key="edit"
          label={`Edit ${subagent.name}`}
          onClick={() => onEditWorkspaceSubagent?.(subagent)}
        />,
        <DrawerListActionButton
          disabled={busy || !onDeleteWorkspaceSubagent}
          icon={<Trash2 aria-hidden="true" />}
          key="delete"
          label={`Delete ${subagent.name}`}
          tone="danger"
          onClick={() => onDeleteWorkspaceSubagent?.(subagent.name)}
        />,
      ]}
      detail={detail}
      meta={subagent.schema || "subagent"}
      title={subagent.name || "unnamed subagent"}
    />
  );
}

export function SubagentForm({status, onCancelWorkspaceSubagentEdit, onSaveWorkspaceSubagent, onUpdateWorkspaceSubagentForm}) {
  const form = status.form || {};
  return (
    <form
      className="skill-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSaveWorkspaceSubagent?.();
      }}
    >
      <label>
        Subagent name
        <input
          autoComplete="off"
          disabled={status.saving || Boolean(form.editing)}
          name="name"
          placeholder="reviewer"
          type="text"
          value={form.name || ""}
          onChange={(event) => onUpdateWorkspaceSubagentForm?.({name: event.target.value})}
        />
      </label>
      <label>
        Description
        <input
          autoComplete="off"
          disabled={status.saving}
          name="description"
          placeholder="Focus on correctness, regressions, and missing tests."
          type="text"
          value={form.description || ""}
          onChange={(event) => onUpdateWorkspaceSubagentForm?.({description: event.target.value})}
        />
      </label>
      <label>
        Instructions
        <textarea
          disabled={status.saving}
          name="instructions"
          placeholder="Describe the work this subagent should handle."
          rows={8}
          value={form.instructions || ""}
          onChange={(event) => onUpdateWorkspaceSubagentForm?.({instructions: event.target.value})}
        />
      </label>
      <div className="skill-form-actions">
        <Button
          disabled={status.saving || !String(form.name || "").trim() || !String(form.description || "").trim() || !String(form.instructions || "").trim()}
          type="submit"
        >
          <Save aria-hidden="true" />
          {status.saving ? "Saving..." : form.editing ? "Save changes" : "Create subagent"}
        </Button>
        {form.editing ? (
          <Button disabled={status.saving} type="button" variant="secondary" onClick={onCancelWorkspaceSubagentEdit}>
            <X aria-hidden="true" />
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function SubagentsBody({selectedSession, status, subagents, onDeleteWorkspaceSubagent, onEditWorkspaceSubagent}) {
  const harness = sessionSubagentHarness(selectedSession);
  if (!selectedSession) {
    return <p className="empty">Start or select an active Pi or Codex session to manage workspace subagents.</p>;
  }
  if (!sessionSupportsSubagents(selectedSession)) {
    return <p className="empty">Workspace subagents are available for Pi and Codex sessions only.</p>;
  }
  if (status.loading) {
    return <p className="empty">Loading workspace subagents...</p>;
  }
  if (status.error) {
    return <p className="empty">{status.error}</p>;
  }
  if (!subagents.length) {
    return <p className="empty">No workspace subagents yet. Subagents created here are written to {harness?.examplePath || "/workspace/<subagent-path>"}.</p>;
  }
  return (
    <DrawerList className="skill-list">
      {subagents.map((subagent) => (
        <SubagentRow
          busy={status.saving}
          key={subagent.path || subagent.name}
          subagent={subagent}
          onDeleteWorkspaceSubagent={onDeleteWorkspaceSubagent}
          onEditWorkspaceSubagent={onEditWorkspaceSubagent}
        />
      ))}
    </DrawerList>
  );
}

export function SubagentsPanel({
  selectedSession,
  state,
  workspaceSubagents,
  onCancelWorkspaceSubagentEdit,
  onDeleteWorkspaceSubagent,
  onEditWorkspaceSubagent,
  onOpenWorkspaceSubagentModal,
  onRefreshWorkspaceSubagents,
  onToggleDrawerSection,
}) {
  const harness = sessionSubagentHarness(selectedSession);
  const status = workspaceSubagents || {loading: false, saving: false, error: "", message: "", data: null, form: {}};
  const subagents = status.data && Array.isArray(status.data.subagents) ? status.data.subagents : [];
  const canManageSubagents = selectedSession && sessionSupportsSubagents(selectedSession);

  return (
    <DrawerSection
      actions={[
        <Button
          aria-label="New subagent"
          disabled={status.loading || status.saving || !canManageSubagents || !onOpenWorkspaceSubagentModal}
          icon={true}
          key="new-subagent"
          size="compact"
          tooltip="New subagent"
          variant="secondary"
          onClick={() => {
            onCancelWorkspaceSubagentEdit?.();
            onOpenWorkspaceSubagentModal?.();
          }}
        >
          <Plus aria-hidden="true" />
        </Button>,
        <Button
          aria-label="Refresh"
          disabled={status.loading || status.saving || !onRefreshWorkspaceSubagents}
          icon={true}
          key="refresh-subagents"
          size="compact"
          tooltip="Refresh"
          variant="secondary"
          onClick={onRefreshWorkspaceSubagents}
        >
          <RefreshCw aria-hidden="true" />
        </Button>,
      ]}
      className="skills-panel"
      id="right-subagents"
      state={state}
      title="Subagents"
      onToggleDrawerSection={onToggleDrawerSection}
    >
      <p className="subtle">
        {harness ?
          `${harness.label} discovers project subagents under ${harness.relativePath}; ${harness.restartHint.charAt(0).toLowerCase()}${harness.restartHint.slice(1)}` :
          "Project subagents for the active Pi or Codex harness."}
      </p>
      {status.message ? <p className="subtle">{status.message}</p> : null}
      <SubagentsBody
        selectedSession={selectedSession}
        status={status}
        subagents={subagents}
        onDeleteWorkspaceSubagent={onDeleteWorkspaceSubagent}
        onEditWorkspaceSubagent={(subagent) => {
          onEditWorkspaceSubagent?.(subagent);
          onOpenWorkspaceSubagentModal?.();
        }}
      />
    </DrawerSection>
  );
}
