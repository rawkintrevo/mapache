import {Trash2} from "lucide-react";
import {getWorkspaceTag, workspaceSourceSummary} from "../workspaces/workspaceSourceSummary.js";
import {DrawerList, DrawerListActionButton, DrawerListItem} from "./DrawerList.jsx";

export function WorkspaceDrawerList({busy, selectedWorkspaceId, workspaces, onDeleteWorkspace, onSelectWorkspace}) {
  if (!workspaces.length) {
    return <p className="empty">No workspaces yet.</p>;
  }

  return (
    <DrawerList>
      {workspaces.map((workspace) => {
        const isActive = workspace.id === selectedWorkspaceId;
        return (
          <DrawerListItem
            actions={[
              <DrawerListActionButton
                disabled={busy}
                icon={<Trash2 aria-hidden="true" />}
                key="delete-workspace"
                label={`Delete workspace ${workspace.name}`}
                title="Delete workspace"
                tone="danger"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteWorkspace(workspace.id);
                }}
              />,
            ]}
            active={isActive}
            badge={getWorkspaceTag(workspace)}
            key={workspace.id}
            meta={workspaceSourceSummary(workspace)}
            title={workspace.name}
            onSelect={() => onSelectWorkspace(workspace.id)}
          />
        );
      })}
    </DrawerList>
  );
}
