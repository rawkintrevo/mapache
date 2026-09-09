import {Check, Unplug} from "lucide-react";
import {DrawerList, DrawerListActionButton} from "../drawers/DrawerList.jsx";
import {InspectorResourcePanel, InspectorResourceRow, resourceBusy} from "./InspectorResourcePanel.jsx";

export function GoogleWorkspacePanel({
  googleWorkspace,
  state,
  onBindConnection,
  onDeleteConnection,
  onEditConnection,
  onRefresh,
  onToggleDrawerSection,
  onUnbindConnection,
}) {
  const status = googleWorkspace || {loading: false, connecting: false, saving: false, deleting: false, error: "", message: "", data: null};
  const data = status.data || {};
  const accounts = Array.isArray(data.connections) ? data.connections : [];
  const binding = data.binding;
  const busy = resourceBusy(status);

  return (
    <InspectorResourcePanel
      className="google-workspace-panel"
      create={{
        disabled: !onEditConnection,
        label: "Add Google account",
        onClick: () => onEditConnection?.(null),
      }}
      id="right-google-workspace"
      refresh={{label: "Refresh Google Workspace", onClick: onRefresh}}
      state={state}
      status={{...status, message: ""}}
      title="Google Workspace"
      singularLabel="Google account"
      onToggleDrawerSection={onToggleDrawerSection}
    >
      {accounts.length ? (
        <DrawerList className="google-workspace-accounts">
          {accounts.map((account) => {
            const enabled = binding?.connectionId === account.connectionId;
            const serviceKeys = Array.isArray(account.enabledServices) ? account.enabledServices : [];
            return (
              <InspectorResourceRow
                busy={busy}
                detail={<span className="subtle">
                  {account.status === "connected" ? "Ready" : "Reconnect required"}
                  {account.workspaceUsage?.count ? ` · ${account.workspaceUsage.count} workspace${account.workspaceUsage.count === 1 ? "" : "s"}` : ""}
                </span>}
                meta={account.displayName || "Google account"}
                resource={account}
                key={account.connectionId}
                title={account.email}
                extraActions={[
                  <DrawerListActionButton
                    disabled={busy || (enabled ? !onUnbindConnection : !onBindConnection) || (!enabled && !serviceKeys.length)}
                    icon={enabled ? <Check aria-hidden="true" /> : <Unplug aria-hidden="true" />}
                    key="toggle"
                    label={`${enabled ? "Disable" : "Enable"} ${account.email}`}
                    onClick={() => enabled ? onUnbindConnection?.() : onBindConnection?.(account.connectionId, serviceKeys)}
                  />,
                ]}
                edit={{
                  label: `Edit ${account.email}`,
                  onClick: onEditConnection,
                }}
                onDelete={{
                  label: `Remove ${account.email}`,
                  onClick: (item) => {
                    const count = Number(item.workspaceUsage?.count || 0);
                    const usage = count ? ` It is used by ${count} workspace${count === 1 ? "" : "s"}; those bindings will be disconnected.` : "";
                    if (window.confirm(`Remove Google account ${item.email}?${usage}`)) onDeleteConnection?.(item.connectionId);
                  },
                }}
              />
            );
          })}
        </DrawerList>
      ) : status.loading ? (
        <p className="subtle">Loading saved Google accounts...</p>
      ) : (
        <p className="empty">No saved Google accounts.</p>
      )}
    </InspectorResourcePanel>
  );
}
