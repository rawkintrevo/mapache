import {getWorkspaceTag, workspaceSourceSummary} from "./workspaceSourceSummary.js";

export function WorkspaceHeader({workspace}) {
  if (!workspace) {
    return (
      <div>
        <h1>Create a workspace</h1>
        <p className="subtle">Create a workspace, then press Play to start its runtime.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>
        {workspace.name}
        <span className="pill" style={{marginLeft: "10px"}}>{getWorkspaceTag(workspace)}</span>
      </h1>
      <p className="subtle">{workspaceSourceSummary(workspace)} · Use Play/Pause in the navigation bar to control the runtime.</p>
    </div>
  );
}
