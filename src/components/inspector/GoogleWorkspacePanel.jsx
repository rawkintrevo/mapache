import {Check, Cloud, ExternalLink, Link2, Unplug} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {DrawerList, DrawerListActionButton} from "../drawers/DrawerList.jsx";
import {InspectorResourcePanel, InspectorResourceRow, resourceBusy} from "./InspectorResourcePanel.jsx";

function serviceLabel(service) {
  return service.displayName || service.key;
}

export function GoogleWorkspacePanel({
  googleWorkspace,
  selectedSession,
  state,
  onBindConnection,
  onDeleteConnection,
  onRefresh,
  onRestartSession,
  onStartConnection,
  onToggleDrawerSection,
  onUnbindConnection,
  onUpdateAccessLevel,
  onUpdateService,
}) {
  const status = googleWorkspace || {loading: false, connecting: false, saving: false, deleting: false, error: "", message: "", data: null, selectedServices: [], accessLevel: "read"};
  const data = status.data || {};
  const services = Array.isArray(data.services) ? data.services : [];
  const accounts = Array.isArray(data.connections) ? data.connections : [];
  const binding = data.binding;
  const selected = new Set(status.selectedServices || []);
  const boundConnection = data.connection;
  const busy = resourceBusy(status);
  const canWrite = [...selected].every((key) => services.find((service) => service.key === key)?.accessLevels?.includes("write"));
  const canRestart = selectedSession?.status === "running" && Boolean(onRestartSession);

  return (
    <InspectorResourcePanel
      className="google-workspace-panel"
      create={{
        disabled: !onStartConnection,
        label: "Connect Google account",
        onClick: () => onStartConnection?.({reconnect: false}),
      }}
      id="right-google-workspace"
      description="Connect a Google account to this workspace. Only the services you select are exposed to new MCP sessions."
      refresh={{label: "Refresh Google Workspace", onClick: onRefresh}}
      state={state}
      status={status}
      title="Google Workspace"
      singularLabel="Google account"
      onToggleDrawerSection={onToggleDrawerSection}
    >
      {status.message?.includes("Restart active sessions") && canRestart ? (
        <Button
          className="google-workspace-restart"
          disabled={busy}
          variant="secondary"
          onClick={() => onRestartSession(selectedSession.id)}
        >
          Restart active session
        </Button>
      ) : null}
      {boundConnection ? (
        <div className="google-workspace-account google-workspace-account--active">
          <Cloud aria-hidden="true" />
          <div>
            <strong>{boundConnection.email}</strong>
            <span className="subtle">Connected to this workspace</span>
          </div>
          <DrawerListActionButton
            disabled={busy || !onUnbindConnection}
            icon={<Unplug aria-hidden="true" />}
            label="Disconnect Google from this workspace"
            tone="danger"
            onClick={onUnbindConnection}
          />
        </div>
      ) : (
        <p className="empty">No Google account is connected to this workspace.</p>
      )}
      {services.length ? (
        <div className="google-workspace-services">
          <strong>Workspace services</strong>
          {services.map((service) => (
            <label className="google-workspace-service" key={service.key}>
              <input
                aria-label={`${serviceLabel(service)} Google service`}
                checked={selected.has(service.key)}
                disabled={busy}
                type="checkbox"
                onChange={(event) => onUpdateService?.(service.key, event.target.checked)}
              />
              <span>
                <span>{serviceLabel(service)}</span>
                <span className="subtle">{service.accessLevels?.includes("write") ? "Read or write" : "Read only"}</span>
              </span>
            </label>
          ))}
          <label>
            Access level
            <select
              disabled={busy || !selected.size}
              value={status.accessLevel || "read"}
              onChange={(event) => onUpdateAccessLevel?.(event.target.value)}
            >
              <option value="read">Read only</option>
              <option disabled={!canWrite} value="write">Read and write</option>
            </select>
          </label>
          <Button
            disabled={busy || !selected.size || !onStartConnection}
            onClick={() => onStartConnection?.({reconnect: Boolean(boundConnection)})}
          >
            <ExternalLink aria-hidden="true" />
            {status.connecting ? "Opening Google..." : boundConnection ? "Reconnect / change account" : "Connect Google account"}
          </Button>
          {boundConnection ? (
            <Button
              disabled={busy || !onBindConnection}
              variant="secondary"
              onClick={() => onBindConnection(binding.connectionId)}
            >
              Apply selected services
            </Button>
          ) : null}
        </div>
      ) : status.loading ? <p className="subtle">Loading Google services...</p> : null}
      {accounts.length ? (
        <div className="google-workspace-accounts">
          <strong>Saved Google accounts</strong>
          <DrawerList>
            {accounts.map((account) => (
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
                    disabled={busy || binding?.connectionId === account.connectionId}
                    icon={binding?.connectionId === account.connectionId ? <Check aria-hidden="true" /> : <Link2 aria-hidden="true" />}
                    key="use"
                    label={`${binding?.connectionId === account.connectionId ? "In use" : "Use"} ${account.email}`}
                    onClick={() => onBindConnection?.(account.connectionId)}
                  />,
                ]}
                edit={{
                  label: `Reconnect ${account.email}`,
                  onClick: () => onStartConnection?.({reconnect: true}),
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
            ))}
          </DrawerList>
        </div>
      ) : null}
    </InspectorResourcePanel>
  );
}
