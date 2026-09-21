import {Activity} from "lucide-react";
import {useEffect, useState} from "react";
import {Button} from "../common/Button.jsx";
import "./InstancesPage.css";

const TYPES = ["main", "automation"];
const STATUSES = ["provisioning", "running", "stopping", "cleanup-error"];

export function InstancesPage({
  onLoad,
  onLoadNextPage,
  onSelectWorkspace,
  onSetFilters,
  onShowHistory,
  onStopInstance,
  state,
}) {
  const inventory = state.instances;
  const [draftFilters, setDraftFilters] = useState(() => ({...inventory.filters}));
  const workspaceNames = new Map((state.workspaces || []).map((workspace) => [workspace.id, workspace.name]));

  useEffect(() => {
    setDraftFilters({...inventory.filters});
  }, [inventory.filters]);

  function applyFilters(event) {
    event.preventDefault();
    onSetFilters?.(Object.fromEntries(Object.entries(draftFilters).filter(([, value]) => String(value || "").trim())));
  }

  function clearFilters() {
    const cleared = {workspaceId: "", type: "", status: ""};
    setDraftFilters(cleared);
    onSetFilters?.(cleared);
  }

  return (
    <div className="instances-page">
      <header className="instances-page__header">
        <div>
          <p className="eyebrow">Account compute</p>
          <h2><Activity aria-hidden="true" /> Running instances</h2>
          <p className="subtle">Owner-wide live inventory across main workspaces and automation runs.</p>
        </div>
        <Button disabled={inventory.loading} variant="secondary" onClick={() => onLoad?.()}>Refresh</Button>
      </header>
      <form aria-label="Running instance filters" className="instances-filters" onSubmit={applyFilters}>
        <label>
          Workspace
          <select value={draftFilters.workspaceId || ""} onChange={(event) => setDraftFilters({...draftFilters, workspaceId: event.target.value})}>
            <option value="">All workspaces</option>
            {(state.workspaces || []).map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
        </label>
        <label>
          Type
          <select value={draftFilters.type || ""} onChange={(event) => setDraftFilters({...draftFilters, type: event.target.value})}>
            <option value="">All types</option>
            {TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
        <label>
          Status
          <select value={draftFilters.status || ""} onChange={(event) => setDraftFilters({...draftFilters, status: event.target.value})}>
            <option value="">All statuses</option>
            {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        <div className="instances-filters__actions">
          <Button disabled={inventory.loading} type="submit">Apply filters</Button>
          <Button disabled={inventory.loading} variant="secondary" onClick={clearFilters}>Clear</Button>
        </div>
      </form>
      {inventory.error ? <p className="error" role="alert">{inventory.error}</p> : null}
      <section aria-label="Running instances" className="instances-card">
        <div className="instances-card__heading">
          <h3>Live inventory</h3>
          <span className="subtle">{inventory.instances.length} loaded</span>
        </div>
        {inventory.instances.length ? (
          <div className="instances-table-wrap">
            <table className="instances-table">
              <thead><tr><th>Workspace</th><th>Type</th><th>Status</th><th>Elapsed</th><th>CPU / memory</th><th>Heartbeat</th><th>Actions</th></tr></thead>
              <tbody>
                {inventory.instances.map((instance) => (
                  <InstanceRow
                    instance={instance}
                    key={`${instance.type}-${instance.runId || instance.sessionId || instance.id}`}
                    workspaceName={workspaceNames.get(instance.workspaceId) || `Workspace ${instance.workspaceId || "unknown"}`}
                    onSelectWorkspace={onSelectWorkspace}
                    onShowHistory={onShowHistory}
                    onStopInstance={onStopInstance}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : inventory.loading ? <p className="subtle">Loading running instances...</p> : <p className="subtle">No active instances match these filters.</p>}
        {inventory.nextCursor ? <Button disabled={inventory.loading} variant="secondary" onClick={onLoadNextPage}>Load more instances</Button> : null}
      </section>
    </div>
  );
}

function InstanceRow({instance, onSelectWorkspace, onShowHistory, onStopInstance, workspaceName}) {
  const status = String(instance.status || "unknown").toLowerCase();
  const canStop = status !== "cleanup-error" && ["provisioning", "running", "stopping"].includes(status);
  const resources = instance.resources || {};
  return (
    <tr>
      <td>
        <button className="instances-link" type="button" onClick={() => onSelectWorkspace?.(instance.workspaceId)}>{workspaceName}</button>
        {instance.type === "automation" && instance.runId ? <button className="instances-link instances-link--secondary" type="button" onClick={() => onShowHistory?.(instance.runId)}>View run history</button> : null}
      </td>
      <td>{instance.type === "automation" ? "Automation" : "Main workspace"}</td>
      <td><span className={`automation-status automation-status--${status}`}>{status}</span></td>
      <td>{formatElapsed(instance.startedAt)}</td>
      <td>{resources.cpu || "—"} / {resources.memory || "—"}</td>
      <td>{formatInstanceTimestamp(instance.heartbeatAt)}</td>
      <td>
        {canStop ? <Button disabled={status === "stopping"} size="small" variant="secondary" onClick={() => onStopInstance?.(instance)}>Stop</Button> : <span className="subtle">{status === "cleanup-error" ? "Cleanup needs attention" : "—"}</span>}
      </td>
    </tr>
  );
}

function formatInstanceTimestamp(value) {
  if (!value) return "—";
  const date = new Date(typeof value?.toDate === "function" ? value.toDate() : value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString([], {dateStyle: "medium", timeStyle: "short"});
}

export function formatElapsed(value, now = Date.now()) {
  const started = new Date(value || "").getTime();
  if (!Number.isFinite(started)) return "—";
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
