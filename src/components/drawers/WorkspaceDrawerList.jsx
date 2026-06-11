import {workspaceSourceSummary} from "../workspaces/workspaceSourceSummary.js";

export function WorkspaceDrawerList({busy, selectedWorkspaceId, workspaces, onOpenSessionModal, onSelectWorkspace}) {
  if (!workspaces.length) {
    return <p className="empty">No workspaces yet.</p>;
  }

  return (
    <div className="list">
      {workspaces.map((workspace) => {
        const isActive = workspace.id === selectedWorkspaceId;
        return (
          <div className={`row workspace-row ${isActive ? "active" : ""}`} key={workspace.id}>
            <button className="workspace-select" type="button" onClick={() => onSelectWorkspace(workspace.id)}>
              <span className="row-title">
                <span>{workspace.name}</span>
                <span className="pill">{workspace.id.slice(0, 5)}</span>
              </span>
              <span className="subtle">{workspaceSourceSummary(workspace)}</span>
            </button>
            {isActive ? (
              <button
                aria-label={`Create session in ${workspace.name}`}
                className="workspace-add"
                disabled={busy}
                title="Create session"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenSessionModal();
                }}
              >
                +
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
