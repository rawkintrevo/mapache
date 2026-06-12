import {Plus} from "lucide-react";
import {workspaceSourceSummary} from "../workspaces/workspaceSourceSummary.js";
import {DrawerList, DrawerListActionButton, DrawerListItem} from "./DrawerList.jsx";

export function WorkspaceDrawerList({busy, selectedWorkspaceId, workspaces, onOpenSessionModal, onSelectWorkspace}) {
  if (!workspaces.length) {
    return <p className="empty">No workspaces yet.</p>;
  }

  return (
    <DrawerList>
      {workspaces.map((workspace) => {
        const isActive = workspace.id === selectedWorkspaceId;
        return (
          <DrawerListItem
            actions={isActive ? [
              <DrawerListActionButton
                disabled={busy}
                icon={<Plus aria-hidden="true" />}
                key="create-session"
                label={`Create session in ${workspace.name}`}
                title="Create session"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenSessionModal();
                }}
              />,
            ] : []}
            active={isActive}
            badge={workspace.id.slice(0, 5)}
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
