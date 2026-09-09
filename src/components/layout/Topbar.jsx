import "./Topbar.css";
import {Pencil, Plus, RefreshCw, Trash2} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {hasPendingOperations} from "../../state/pendingOperations.js";

export function Topbar({state, onDeleteWorkspace, onOpenWorkspaceEditModal, onOpenWorkspaceModal, onRefresh, onSelectWorkspace}) {
  const busy = hasPendingOperations(state.pendingOperations);
  const selectedWorkspace = state.workspaces.find(
      (workspace) => workspace.id === state.selectedWorkspaceId,
  );

  return (
    <header className="topbar">
      <div className="brand">
        <div aria-hidden="true" className="mark">pi</div>
        <h1>Mapache Tools</h1>
      </div>
      <div className="topbar-workspace-controls">
        <label className="visually-hidden" htmlFor="topbar-workspace-select">Workspace</label>
        <select
          aria-label="Workspace"
          className="topbar-workspace-select"
          disabled={busy || !state.workspaces.length}
          id="topbar-workspace-select"
          value={state.selectedWorkspaceId || ""}
          onChange={(event) => onSelectWorkspace(event.target.value)}
        >
          {!selectedWorkspace ? (
            <option value="">{state.workspaces.length ? "Select a workspace" : "No workspaces yet"}</option>
          ) : null}
          {state.workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
          ))}
        </select>
        <Button
          aria-label="Create workspace"
          disabled={busy}
          icon
          title="Create workspace"
          tooltip="Create workspace"
          variant="secondary"
          onClick={onOpenWorkspaceModal}
        >
          <Plus aria-hidden="true" />
        </Button>
        <Button
          aria-label={selectedWorkspace ? `Edit workspace ${selectedWorkspace.name}` : "Edit selected workspace"}
          disabled={busy || !selectedWorkspace}
          icon
          title={selectedWorkspace ? `Edit workspace ${selectedWorkspace.name}` : "Edit selected workspace"}
          tooltip={selectedWorkspace ? `Edit workspace ${selectedWorkspace.name}` : "Edit selected workspace"}
          variant="secondary"
          onClick={onOpenWorkspaceEditModal}
        >
          <Pencil aria-hidden="true" />
        </Button>
        <Button
          aria-label={selectedWorkspace ? `Delete workspace ${selectedWorkspace.name}` : "Delete selected workspace"}
          disabled={busy || !selectedWorkspace}
          icon
          title={selectedWorkspace ? `Delete workspace ${selectedWorkspace.name}` : "Delete selected workspace"}
          tooltip={selectedWorkspace ? `Delete workspace ${selectedWorkspace.name}` : "Delete selected workspace"}
          variant="secondary"
          onClick={() => onDeleteWorkspace(selectedWorkspace?.id)}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
      <div className="topbar-actions">
        <a className="topbar-link" href="/community/blog">Blog</a>
        <a className="topbar-link" href="/community/docs/intro/">Docs</a>
        <Button
          aria-label="Refresh app state"
          disabled={busy}
          icon
          title={busy ? "Working..." : "Refresh"}
          variant="secondary"
          onClick={onRefresh}
        >
          <RefreshCw aria-hidden="true" />
        </Button>
      </div>
    </header>
  );
}
