import {useEffect, useMemo, useState} from "react";
import {Button} from "../common/Button.jsx";
import {RunDetailsPanel} from "./RunDetailsPanel.jsx";
import "./RunHistoryPage.css";

const STATUSES = ["queued", "provisioning", "running", "stopping", "succeeded", "failed", "canceled", "interrupted", "skipped"];

export function RunHistoryPage({
  onLoadEvents,
  onLoadHistory,
  onLoadNextPage,
  onRestartRun,
  onSelectRun,
  onSetFilters,
  onStopRun,
  embedded = false,
  state,
}) {
  const history = state.automations.globalHistory || state.automations.history;
  const [draftFilters, setDraftFilters] = useState(() => ({...history.filters}));
  const selectedRun = state.automations.selectedRunScope === "global" ? state.automations.selectedRun : null;
  const workspaceNames = useMemo(() => new Map((state.workspaces || []).map((workspace) => [workspace.id, workspace.name])), [state.workspaces]);

  useEffect(() => {
    setDraftFilters({...history.filters});
  }, [history.filters]);

  useEffect(() => {
    onLoadHistory?.();
  }, [onLoadHistory]);

  function applyFilters(event) {
    event.preventDefault();
    const filters = Object.fromEntries(Object.entries(draftFilters).filter(([, value]) => String(value || "").trim()));
    onSetFilters?.(filters);
  }

  function clearFilters() {
    setDraftFilters({});
    onSetFilters?.({});
  }

  return (
    <div className={`run-history-page${embedded ? " run-history-page--embedded" : ""}`}>
      <header className="run-history-page__header">
        <div>
          <p className="eyebrow">Automations</p>
          <h2>Run history</h2>
          <p className="subtle">Review scheduled and manual runs across every workspace.</p>
        </div>
        <Button disabled={history.loading} variant="secondary" onClick={() => onLoadHistory?.()}>Refresh</Button>
      </header>
      <form className="run-history-filters" onSubmit={applyFilters}>
        <label>
          Workspace
          <select value={draftFilters.workspaceId || ""} onChange={(event) => setDraftFilters({...draftFilters, workspaceId: event.target.value})}>
            <option value="">All workspaces</option>
            {(state.workspaces || []).map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
        </label>
        <label>
          Workflow ID
          <input autoComplete="off" placeholder="All workflows" value={draftFilters.automationId || ""} onChange={(event) => setDraftFilters({...draftFilters, automationId: event.target.value})} />
        </label>
        <label>
          Status
          <select value={draftFilters.status || ""} onChange={(event) => setDraftFilters({...draftFilters, status: event.target.value})}>
            <option value="">All statuses</option>
            {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        <label>
          From
          <input type="date" value={draftFilters.from || ""} onChange={(event) => setDraftFilters({...draftFilters, from: event.target.value})} />
        </label>
        <label>
          To
          <input type="date" value={draftFilters.to || ""} onChange={(event) => setDraftFilters({...draftFilters, to: event.target.value})} />
        </label>
        <div className="run-history-filters__actions">
          <Button disabled={history.loading} type="submit">Apply filters</Button>
          <Button disabled={history.loading || !Object.keys(draftFilters).length} variant="secondary" onClick={clearFilters}>Clear</Button>
        </div>
      </form>
      {history.error ? <p className="error" role="alert">{history.error}</p> : null}
      <div className="run-history-layout">
        <section aria-label="Automation runs" className="run-history-list">
          <div className="run-history-list__heading">
            <h3>Latest runs</h3>
            <span className="subtle">{history.runs.length} loaded</span>
          </div>
          {history.runs.length ? (
            <div className="run-history-table-wrap">
              <table>
                <thead><tr><th>Workflow</th><th>Workspace</th><th>Status</th><th>Created</th><th>Reason</th></tr></thead>
                <tbody>
                  {history.runs.map((run) => (
                    <tr className={selectedRun?.id === run.id ? "run-history-row--selected" : ""} key={run.id}>
                      <td><button className="run-history-row__button" type="button" onClick={() => onSelectRun?.(run.id)}>{run.automationName || run.snapshot?.name || run.automationId || "Unnamed automation"}</button></td>
                      <td>{workspaceNames.get(run.workspaceId) || `Workspace ${run.workspaceId || "unknown"}`}</td>
                      <td><span className={`automation-status automation-status--${String(run.status || "unknown").toLowerCase()}`}>{run.status || "unknown"}</span></td>
                      <td>{formatDate(run.createdAt)}</td>
                      <td>{run.skippedReason || run.cleanupErrorCode || run.persistenceState || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : history.loading ? <p className="subtle">Loading run history...</p> : <p className="subtle">No runs match these filters.</p>}
          {history.nextCursor ? <Button disabled={history.loading} variant="secondary" onClick={onLoadNextPage}>Load more runs</Button> : null}
        </section>
        <RunDetailsPanel
          busy={state.automations.busy}
          events={state.automations.events}
          eventsNextCursor={state.automations.eventsNextCursor}
          onLoadMoreEvents={onLoadEvents}
          onRestartRun={onRestartRun}
          onSelectRun={onSelectRun}
          onStopRun={onStopRun}
          run={selectedRun}
        />
      </div>
    </div>
  );
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(typeof value?.toDate === "function" ? value.toDate() : value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString([], {dateStyle: "medium", timeStyle: "short"});
}
