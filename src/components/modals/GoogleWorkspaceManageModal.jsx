import {Check, Plus, RefreshCw, Unplug, X} from "lucide-react";
import "../drawers/Drawers.css";
import "../inspector/InspectorPanels.css";
import {Button} from "../common/Button.jsx";
import {DrawerList, DrawerListActionButton} from "../drawers/DrawerList.jsx";
import {InspectorResourceRow, resourceBusy} from "../inspector/InspectorResourcePanel.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

export function GoogleWorkspaceManageModal({
  googleWorkspace,
  onBindConnection,
  onClose,
  onDeleteConnection,
  onEditConnection,
  onRefresh,
  onUnbindConnection,
}) {
  const status = googleWorkspace || {loading: false, connecting: false, saving: false, deleting: false, error: "", message: "", data: null};
  const data = status.data || {};
  const accounts = Array.isArray(data.connections) ? data.connections : [];
  const binding = data.binding;
  const busy = resourceBusy(status);

  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="google-workspace-manage-title" aria-modal="true" className="modal-panel google-workspace-manage-panel" role="dialog">
        <div className="modal-heading">
          <div>
            <h2 id="google-workspace-manage-title">Google Workspace</h2>
            <p className="subtle">Manage Google accounts for the selected workspace. Restart an active session after changes.</p>
          </div>
          <Button aria-label="Close" icon title="Close" variant="secondary" onClick={onClose}><X aria-hidden="true" /></Button>
        </div>
        <div className="google-workspace-manage-toolbar">
          <Button disabled={busy || !onEditConnection} variant="secondary" onClick={() => onEditConnection?.(null)}>
            <Plus aria-hidden="true" /> Add Google account
          </Button>
          <Button aria-label="Refresh Google Workspace" disabled={busy || !onRefresh} icon title="Refresh Google Workspace" variant="secondary" onClick={onRefresh}>
            <RefreshCw aria-hidden="true" />
          </Button>
        </div>
        {status.error ? <p className="error">{status.error}</p> : null}
        {status.message ? <p className="subtle">{status.message}</p> : null}
        {accounts.length ? (
          <DrawerList className="google-workspace-accounts">
            {accounts.map((account) => {
              const enabled = binding?.connectionId === account.connectionId;
              const serviceKeys = Array.isArray(account.enabledServices) ? account.enabledServices : [];
              return (
                <InspectorResourceRow
                  busy={busy}
                  detail={<span className="subtle">
                    {account.status === "connected" ? "Authorized" : "Reconnect required"}
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
                  edit={{label: `Edit ${account.email}`, onClick: onEditConnection}}
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
        <div className="modal-actions"><Button variant="secondary" onClick={onClose}>Done</Button></div>
      </section>
    </ModalBackdrop>
  );
}
