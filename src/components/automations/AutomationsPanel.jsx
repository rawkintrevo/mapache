import {useEffect, useMemo, useState} from "react";
import {Blocks, Clock3, Pencil, Play, Plus, RefreshCw, Trash2} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {AutomationEditor, createAutomationDraft} from "./AutomationEditor.jsx";
import "./AutomationsPanel.css";

const ACTIVE_RUN_STATUSES = new Set(["queued", "provisioning", "running", "stopping"]);
const STORAGE_LABELS = {
  legacy: "Legacy storage",
  preparing: "Preparing storage",
  migrating: "Migrating storage",
  ready: "Ready",
  error: "Storage error",
};

export function AutomationsPanel({
  onCreateDefinition,
  onDeleteDefinition,
  onLoadHistory,
  onLoadWorkspace,
  onOpenHistory,
  onPrepareStorage,
  onPreviewSchedule,
  onRunNow,
  onUpdateDefinition,
  onUpdateSettings,
  onRefresh,
  onShowWorkspace,
  state,
}) {
  const automationState = state.automations;
  const workspace = state.workspaces.find((item) => item.id === state.selectedWorkspaceId);
  const [editor, setEditor] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [settingsValue, setSettingsValue] = useState(String(automationState.maxConcurrency || 1));
  const storageState = String(automationState.storageState || workspace?.sharedStorage?.state || "legacy").toLowerCase();
  const storageReady = storageState === "ready";
  const canonicalSession = state.sessions.find((session) => session.id === workspace?.canonicalSessionId) ||
    state.sessions.find((session) => session.id === state.selectedSessionId);
  const mainActive = ACTIVE_RUN_STATUSES.has(String(canonicalSession?.status || "").toLowerCase());
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
    setPreview(null);
    if (!state.selectedWorkspaceId) return;
    void onLoadWorkspace?.(state.selectedWorkspaceId);
    void onLoadHistory?.({workspaceId: state.selectedWorkspaceId, filters: {workspaceId: state.selectedWorkspaceId}});
  }, [onLoadHistory, onLoadWorkspace, state.selectedWorkspaceId]);

  if (!workspace) {
    return (
      <section className="automations-panel automations-panel--empty" aria-labelledby="automations-title">
        <Blocks aria-hidden="true" size={32} />
        <h2 id="automations-title">Automations</h2>
        <p className="subtle">Select a workspace to manage its scheduled automations.</p>
      </section>
    );
  }

  function beginCreate() {
    setPreview(null);
    setEditor({isCreating: true, draft: createAutomationDraft({userTimezone: state.profile?.timezone || ""})});
  }

  function beginEdit(automation) {
    setPreview(null);
    setEditor({automationId: automation.id, draft: createAutomationDraft({automation, userTimezone: state.profile?.timezone || ""})});
  }

  async function saveDefinition(payload) {
    const result = editor?.isCreating ?
      await onCreateDefinition?.(payload, state.selectedWorkspaceId) :
      await onUpdateDefinition?.(editor?.automationId, payload, state.selectedWorkspaceId);
    if (result) {
      setEditor(null);
      setPreview(null);
      await onLoadHistory?.({workspaceId: state.selectedWorkspaceId, filters: {workspaceId: state.selectedWorkspaceId}});
    }
  }

  async function toggleDefinition(automation) {
    if (!storageReady && automation.enabled !== true) return;
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

  const currentStorageLabel = STORAGE_LABELS[storageState] || storageState || "Legacy storage";
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
      {automationState.error ? <p className="error" role="alert">{automationState.error}</p> : null}
      <section className={`automation-storage-card automation-storage-card--${storageState}`} aria-label="Automation storage">
        <div>
          <p className="eyebrow">Storage</p>
          <h3>{currentStorageLabel}</h3>
          {storageState === "legacy" || storageState === "error" ? <p className="subtle">Prepare shared GCS storage before enabling or running workflows. Usage-based storage/operation charges and seven-day recovery retention apply.</p> : null}
          {storageState === "preparing" || storageState === "migrating" ? <p className="subtle">Storage preparation is in progress. The main workspace was not stopped automatically.</p> : null}
          {storageState === "error" ? <p className="error">{workspace.sharedStorage?.errorCode || "Storage preparation failed. Retry while the main workspace is paused."}</p> : null}
          {mainActive && !storageReady ? <p className="subtle">Pause the main workspace before preparing storage.</p> : null}
        </div>
        <Button
          disabled={automationState.busy || mainActive || storageState === "preparing" || storageState === "migrating" || storageReady}
          onClick={async () => { await onPrepareStorage?.(state.selectedWorkspaceId); await onRefresh?.(); }}
        >
          {storageReady ? "Storage ready" : storageState === "preparing" || storageState === "migrating" ? "Preparing…" : "Prepare automations"}
        </Button>
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
      {editor ? (
        <AutomationEditor
          busy={automationState.busy}
          conflict={automationState.conflict}
          draft={editor.draft}
          error={automationState.error}
          isCreating={editor.isCreating}
          modelConfigured={Boolean(editor.draft.modelSelection?.modelId || editor.draft.modelSelection?.providerId)}
          onCancel={() => setEditor(null)}
          onChange={(draft) => setEditor({...editor, draft})}
          onPreview={async (cron, timezone) => {
            setPreviewLoading(true);
            const result = await onPreviewSchedule?.(cron, timezone);
            setPreviewLoading(false);
            return result;
          }}
          onPreviewResult={setPreview}
          onSave={saveDefinition}
          preview={preview}
          previewLoading={previewLoading}
          storageReady={storageReady}
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
                      <Button disabled={automationState.busy || !storageReady} size="small" title={!storageReady ? "Prepare storage before running" : "Run now"} variant="secondary" onClick={() => handleRunNow(automation)}><Play aria-hidden="true" /> Run now</Button>
                      <Button disabled={automationState.busy || (!storageReady && automation.enabled !== true)} size="small" variant="secondary" onClick={() => toggleDefinition(automation)}>{automation.enabled ? "Disable" : "Enable"}</Button>
                      <Button disabled={automationState.busy} icon size="small" title="Edit" variant="secondary" onClick={() => beginEdit(automation)}><Pencil aria-hidden="true" /></Button>
                      <Button disabled={automationState.busy} icon size="small" title="Delete" variant="secondary" onClick={() => deleteDefinition(automation)}><Trash2 aria-hidden="true" /></Button>
                    </div>
                    {latest && ACTIVE_RUN_STATUSES.has(String(latest.status || "").toLowerCase()) ? <button className="automation-definition__history-link" type="button" onClick={onOpenHistory}>View active run in history</button> : null}
                  </article>
                );
              })}
            </div>
          ) : <p className="subtle">No automations yet. Disabled workflows can be saved before storage is prepared.</p>}
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
