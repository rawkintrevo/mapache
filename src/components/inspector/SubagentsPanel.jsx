import {Edit3, Save, X} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {DrawerList} from "../drawers/DrawerList.jsx";
import {sessionSubagentHarness, sessionSupportsSubagents} from "../../utils/sessionHarnesses.js";
import {InspectorResourcePanel, InspectorResourceRow} from "./InspectorResourcePanel.jsx";

function SubagentRow({busy, subagent, onDeleteWorkspaceSubagent, onEditWorkspaceSubagent}) {
  const detail = (
    <>
      <span className="drawer-list-row__code">{subagent.path || "<subagent-path>"}</span>
      {subagent.description ? <span className="subtle">{subagent.description}</span> : null}
    </>
  );

  return (
    <InspectorResourceRow
      busy={busy}
      detail={detail}
      meta={subagent.schema || "subagent"}
      resource={subagent}
      title={subagent.name || "unnamed subagent"}
      edit={{
        disabled: !onEditWorkspaceSubagent,
        icon: <Edit3 aria-hidden="true" />,
        onClick: onEditWorkspaceSubagent,
      }}
      onDelete={{
        disabled: !onDeleteWorkspaceSubagent,
        label: `Delete ${subagent.name}`,
        onClick: (item) => onDeleteWorkspaceSubagent?.(item.name),
      }}
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
    <InspectorResourcePanel
      className="skills-panel"
      create={{
        disabled: !canManageSubagents || !onOpenWorkspaceSubagentModal,
        label: "New subagent",
        onClick: () => {
          onCancelWorkspaceSubagentEdit?.();
          onOpenWorkspaceSubagentModal?.();
        },
      }}
      id="right-subagents"
      description={harness ?
        `${harness.label} discovers project subagents under ${harness.relativePath}; ${harness.restartHint.charAt(0).toLowerCase()}${harness.restartHint.slice(1)}` :
        "Project subagents for the active Pi or Codex harness."}
      refresh={{onClick: onRefreshWorkspaceSubagents}}
      state={state}
      status={status}
      title="Subagents"
      singularLabel="subagent"
      onToggleDrawerSection={onToggleDrawerSection}
    >
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
    </InspectorResourcePanel>
  );
}
