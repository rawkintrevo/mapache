import {Square, Trash2} from "lucide-react";
import {SessionStatusSummary} from "../sessions/SessionStatusSummary.jsx";
import {DrawerList, DrawerListActionButton, DrawerListItem} from "./DrawerList.jsx";

export function DrawerSessionList({state, onDeleteSession, onSelectSession, onStopSession}) {
  if (!state.selectedWorkspaceId) {
    return <p className="empty">Select a workspace to view sessions.</p>;
  }

  if (!state.sessions.length) {
    return <p className="empty">No sessions in this workspace.</p>;
  }

  return (
    <DrawerList>
      {state.sessions.map((session) => {
        const actions = [];
        if (session.status === "running") {
          actions.push(
            <DrawerListActionButton
              disabled={state.busy}
              icon={<Square aria-hidden="true" />}
              key="stop"
              label={`Stop ${session.name}`}
              title={`Stop ${session.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onStopSession(session.id);
              }}
            />,
          );
        }
        actions.push(
          <DrawerListActionButton
            disabled={state.busy}
            icon={<Trash2 aria-hidden="true" />}
            key="delete"
            label={`Delete ${session.name}`}
            title={`Delete ${session.name}`}
            tone="danger"
            onClick={(event) => {
              event.stopPropagation();
              onDeleteSession(session.id);
            }}
          />,
        );

        return (
          <DrawerListItem
            actions={actions}
            active={session.id === state.selectedSessionId}
            key={session.id}
            meta={`${session.resources.cpu} CPU / ${session.resources.memory}`}
            title={session.name}
            titleAccessory={<SessionStatusSummary session={session} />}
            onSelect={() => onSelectSession(session.id)}
          />
        );
      })}
    </DrawerList>
  );
}
