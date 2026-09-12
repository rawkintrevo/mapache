import {Pause, Pencil, Play, RotateCcw, Trash2} from "lucide-react";
import {SessionStatusSummary} from "../sessions/SessionStatusSummary.jsx";
import {getSessionResourceSummary, isRetryableProvisioningFailure, isRuntimeStopUncertain} from "../sessions/sessionPresentation.js";
import {hasPendingOperations} from "../../state/pendingOperations.js";
import {DrawerList, DrawerListActionButton, DrawerListItem} from "./DrawerList.jsx";

export function DrawerSessionList({state, onDeleteSession, onEditSession, onRestartSession, onRetryProvisioningSession, onSelectSession, onStopSession}) {
  const busy = hasPendingOperations(state.pendingOperations);
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
        const stopUncertain = isRuntimeStopUncertain(session);
        actions.push(
          <DrawerListActionButton
            disabled={busy}
            icon={<Pencil aria-hidden="true" />}
            key="edit"
            label={`Edit ${session.name}`}
            title={`Edit ${session.name}`}
            onClick={(event) => {
              event.stopPropagation();
              onEditSession?.(session.id);
            }}
          />,
        );
        if (isRetryableProvisioningFailure(session)) {
          actions.push(
            <DrawerListActionButton
              disabled={busy}
              icon={<RotateCcw aria-hidden="true" />}
              key="retry-provisioning"
              label={`Retry provisioning for ${session.name}`}
              title={`Retry provisioning for ${session.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onRetryProvisioningSession?.(session.id);
              }}
            />,
          );
        }
        if (session.status === "running") {
          actions.push(
          <DrawerListActionButton
              disabled={busy || stopUncertain}
              icon={<Pause aria-hidden="true" />}
              key="pause"
              label={`Pause ${session.name}`}
              title={stopUncertain ? "Pause is disabled until the server confirms the stop outcome" : `Pause ${session.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onStopSession(session.id);
              }}
            />,
          );
        } else if (session.status === "stopped") {
          actions.push(
          <DrawerListActionButton
              disabled={busy || stopUncertain}
              icon={<Play aria-hidden="true" />}
              key="resume"
              label={`Resume ${session.name}`}
              title={stopUncertain ? "Resume is disabled until the server confirms the stop outcome" : `Resume ${session.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onRestartSession?.(session.id);
              }}
            />,
          );
        }
        actions.push(
          <DrawerListActionButton
            disabled={busy}
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
            meta={getSessionResourceSummary(session)}
            title={session.name}
            titleAccessory={<SessionStatusSummary session={session} />}
            onSelect={() => onSelectSession(session.id)}
          />
        );
      })}
    </DrawerList>
  );
}
