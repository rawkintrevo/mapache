import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {Clock3, Pencil, Play, Plus, RefreshCw, Trash2} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {AutomationEditor, createAutomationDraft} from "./AutomationEditor.jsx";
import {automationErrorMessage, automationReadiness, hasAutomationModel} from "../../utils/automationReadiness.js";
import "./AutomationsPanel.css";

const ACTIVE_RUN_STATUSES = new Set(["queued", "provisioning", "running", "stopping"]);


export function AutomationsPanel({
  onCreateDefinition,
  onDeleteDefinition,
  onLoadHistory,
  onLoadWorkspace,
  onOpenHistory,
  onPreviewSchedule,
  onRunNow,
  onUpdateDefinition,
  onUpdateSettings,
  onOpenModelSettings,
  onShowWorkspace,
  state,
}) {
  const automationState = state.automations;
  const workspace = state.workspaces.find((item) => item.id === state.selectedWorkspaceId);
  const [editor, setEditor] = useState(null);
  const [previewState, setPreviewState] = useState({data: null, error: "", loading: false});
  const editorSequence = useRef(0);
  const previewSchedule = useCallback((cron, timezone) => onPreviewSchedule?.(cron, timezone), [onPreviewSchedule]);
  const [settingsValue, setSettingsValue] = useState(String(automationState.maxConcurrency || 1));
  const availabilityFor = (automation) => automationReadiness({
    busy: automationState.busy,
    busyAction: automationState.busyAction,
    modelConfigured: hasAutomationModel(automation, workspace),
    mutationBusy: automationState.pendingActions?.some((operation) =>
      ["update", "delete"].includes(operation.action) && operation.automationId === automation?.id) || false,
  });
  const latestRuns = useMemo(() => {
    const result = new Map();
    for (const run of automationState.history.runs || []) {
      if (!result.has(run.automationId)) result.set(run.automationId, run);
    }
    return result;
  }, [automationState.history.runs]);

  useEffect(() => {
    setSettingsValue(String(automationState.maxConcurrency || 1));
  }, [automationState.maxConcurrency]);

  useEffect(() => {
    setEditor(null);
    setPreviewState({data: null, error: "", loading: false});
    if (!state.selectedWorkspaceId) return;
    void onLoadWorkspace?.(state.selectedWorkspaceId);
    void onLoadHistory?.({workspaceId: state.selectedWorkspaceId, filters: {workspaceId: state.selectedWorkspaceId}});
  }, [onLoadHistory, onLoadWorkspace, state.selectedWorkspaceId]);

  if (!workspace) {
    return (
      <section className="automations-panel automations-panel--empty" aria-labelledby="automations-title">
        <Clock3 aria-hidden="true" size={32} />
        <h2 id="automations-title">Automations</h2>
        <p className="subtle">Select a workspace to manage its scheduled automations.</p>
      </section>
    );
  }

  function beginCreate() {
    setPreviewState({data: null, error: "", loading: false});
    setEditor({contextKey: ++editorSequence.current, workspaceId: state.selectedWorkspaceId, isCreating: true, draft: createAutomationDraft({userTimezone: state.profile?.timezone || ""})});
  }

  function beginEdit(automation) {
    setPreviewState({data: null, error: "", loading: false});
    setEditor({contextKey: ++editorSequence.current, workspaceId: state.selectedWorkspaceId, automationId: automation.id, draft: createAutomationDraft({automation, userTimezone: state.profile?.timezone || ""})});
  }

  async function saveDefinition(payload) {
    const result = editor?.isCreating ?
      await onCreateDefinition?.(payload, state.selectedWorkspaceId) :
      await onUpdateDefinition?.(editor?.automationId, payload, state.selectedWorkspaceId);
    if (result) {
      setEditor(null);
      setPreviewState({data: null, error: "", loading: false});
      await onLoadHistory?.({workspaceId: state.selectedWorkspaceId, filters: {workspaceId: state.selectedWorkspaceId}});
    }
  }

  async function toggleDefinition(automation) {
    const availability = availabilityFor(automation);
    if (automation.enabled ? !availability.canDisable : !availability.canEnable) return;
    await onUpdateDefinition?.(automation.id, {enabled: automation.enabled !== true}, state.selectedWorkspaceId);
  }

  async function deleteDefinition(automation) {
    if (!window.confirm(`Delete ${automation.name || "this automation"}? Pending runs will be canceled; active runs continue.`)) return;
    await onDeleteDefinition?.(automation.id, {}, state.selectedWorkspaceId);
    await onLoadHistory?.({workspaceId: state.selectedWorkspaceId, filters: {workspaceId: state.selectedWorkspaceId}});
  }

  function handleRunNow(automation) {
    return onRunNow?.(automation.id, {trigger: "manual"}, state.selectedWorkspaceId);
  }

  async function saveSettings(event) {
    event.preventDefault();
    const value = Number(settingsValue);
    if (!Number.isSafeInteger(value) || value < 1) return;
    await onUpdateSettings?.({automationMaxConcurrency: value}, state.selectedWorkspaceId);
  }

  return (
    <div className="automations-panel">
      <header className="automations-panel__header">
        <div>
          <p className="eyebrow">Workspace automation</p>
          <h2 id="automations-title">{workspace.name} automations</h2>
          <p className="subtle">Create scheduled conversations without starting the workspace runtime.</p>
        </div>
        <div className="automations-panel__header-actions">
          <Button disabled={automationState.busy} variant="secondary" onClick={() => onLoadWorkspace?.(state.selectedWorkspaceId)}><RefreshCw aria-hidden="true" /> Refresh</Button>
          <Button variant="secondary" onClick={onShowWorkspace}>Back to workspace</Button>
        </div>
      </header>
      {automationState.error ? <p className="error" role="alert">{automationErrorMessage(automationState.error)}</p> : null}
      {automationState.error === "missing_model_selection" ? <Button variant="secondary" onClick={onOpenModelSettings || onShowWorkspace}>Back to Agent</Button> : null}
      <section className="automation-storage-card" aria-label="Automation storage">
        <div>
          <p className="eyebrow">Workspace files</p>
          <h3>Read-only workspace, separate outputs</h3>
          <p className="subtle">Each run reads your saved workspace files and writes to its own output folder. Your main session can keep running. Outputs stay separate until you copy them back.</p>
        </div>
      </section>
      <section className="automation-settings-card" aria-label="Automation concurrency settings">
        <form onSubmit={saveSettings}>
          <label>
            Maximum concurrent automations
            <input min="1" type="number" value={settingsValue} onChange={(event) => setSettingsValue(event.target.value)} />
          </label>
          <Button disabled={automationState.busy} type="submit">Save limit</Button>
          <p className="subtle">Lowering the limit does not stop existing runs; it only limits future admission.</p>
        </form>
      </section>
      {editor?.workspaceId === state.selectedWorkspaceId ? (
        <AutomationEditor
          key={`${editor.workspaceId}:${editor.contextKey}`}
          busy={automationState.busy}
          conflict={automationState.conflict}
          draft={editor.draft}
          error={automationErrorMessage(automationState.error)}
          isCreating={editor.isCreating}
          modelConfigured={hasAutomationModel(editor.draft, workspace)}
          readiness={availabilityFor(editor.draft)}
          onOpenModelSettings={onOpenModelSettings || onShowWorkspace}
          onCancel={() => setEditor(null)}
          onChange={(draft) => setEditor({...editor, draft})}
          onPreview={previewSchedule}
          onPreviewStateChange={setPreviewState}
          previewContextKey={`${editor.workspaceId}:${editor.contextKey}`}
          onSave={saveDefinition}
          preview={previewState.data}
          previewError={previewState.error}
          previewLoading={previewState.loading}
          userTimezone={state.profile?.timezone || ""}
        />
      ) : (
        <section className="automation-definition-card" aria-labelledby="automation-list-title">
          <div className="automation-definition-card__heading">
            <div><p className="eyebrow">Definitions</p><h3 id="automation-list-title">Scheduled workflows</h3></div>
            <Button disabled={automationState.busy} onClick={beginCreate}><Plus aria-hidden="true" /> New automation</Button>
          </div>
          {automationState.definitions.length ? (
            <div className="automation-definition-list">
              {automationState.definitions.map((automation) => {
                const availability = availabilityFor(automation);
                const reasonId = `automation-${automation.id}-enable-reason`;
                const latest = latestRuns.get(automation.id);
                const latestLabel = latest ? `${latest.status || "unknown"}${latest.skippedReason ? ` · ${latest.skippedReason}` : ""}` : "No runs";
                return (
                  <article className="automation-definition" key={automation.id}>
                    <div className="automation-definition__main">
                      <div className="automation-definition__title"><h4>{automation.name}</h4><span className={`automation-status automation-status--${automation.enabled ? "succeeded" : "unknown"}`}>{automation.enabled ? "Enabled" : "Disabled"}</span></div>
                      <p className="subtle"><Clock3 aria-hidden="true" size={15} /> {automation.cron} · {automation.timezone}</p>
                      <p className="subtle">Next: {formatDate(automation.nextRunAt)} · Latest: {latestLabel}</p>
                    </div>
                    <div className="automation-definition__actions">
                      <Button aria-describedby={availability.reason ? reasonId : undefined} disabled={!availability.canRun} size="small" title="Run now" variant="secondary" onClick={() => handleRunNow(automation)}><Play aria-hidden="true" /> Run now</Button>
                      <Button aria-describedby={availability.reason ? reasonId : undefined} disabled={automation.enabled ? !availability.canDisable : !availability.canEnable} size="small" variant="secondary" onClick={() => toggleDefinition(automation)}>{automation.enabled ? "Disable" : "Enable"}</Button>
                      <Button disabled={automationState.busy} icon size="small" title="Edit" variant="secondary" onClick={() => beginEdit(automation)}><Pencil aria-hidden="true" /></Button>
                      <Button disabled={automationState.busy} icon size="small" title="Delete" variant="secondary" onClick={() => deleteDefinition(automation)}><Trash2 aria-hidden="true" /></Button>
                    </div>
                    {availability.reason ? <p className="subtle" id={reasonId} role="status">{availability.reason}</p> : null}
                    {!hasAutomationModel(automation, workspace) ? <Button variant="secondary" onClick={onOpenModelSettings || onShowWorkspace}>Back to Agent</Button> : null}
                    {latest && ACTIVE_RUN_STATUSES.has(String(latest.status || "").toLowerCase()) ? <button className="automation-definition__history-link" type="button" onClick={() => onOpenHistory?.(latest.id)}>View active run in history</button> : null}
                  </article>
                );
              })}
            </div>
          ) : <p className="subtle">No automations yet. Create a workflow to get started.</p>}
        </section>
      )}
    </div>
  );
}

function formatDate(value) {
  if (!value) return "not scheduled";
  const date = new Date(typeof value?.toDate === "function" ? value.toDate() : value);
  return Number.isNaN(date.getTime()) ? "not scheduled" : date.toLocaleString([], {dateStyle: "medium", timeStyle: "short"});
}
