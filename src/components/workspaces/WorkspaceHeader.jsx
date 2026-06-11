import {workspaceSourceSummary} from "./workspaceSourceSummary.js";

export function WorkspaceHeader({workspace}) {
  if (!workspace) {
    return (
      <div>
        <h1>Create a workspace</h1>
        <p className="subtle">A workspace owns the storage prefix shared by its sessions.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>{workspace.name}</h1>
      <p className="subtle">{workspaceSourceSummary(workspace)}</p>
    </div>
  );
}
