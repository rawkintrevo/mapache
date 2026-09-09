import {ExternalLink, X} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

function serviceLabel(service) {
  return service.displayName || service.key;
}

export function GoogleWorkspaceModal({googleWorkspace, onClose, onStartConnection, onUpdateAccessLevel, onUpdateService}) {
  const status = googleWorkspace || {connecting: false, saving: false, deleting: false, data: null, selectedServices: [], accessLevel: "read"};
  const data = status.data || {};
  const services = Array.isArray(data.services) ? data.services : [];
  const accounts = Array.isArray(data.connections) ? data.connections : [];
  const account = accounts.find((item) => item.connectionId === status.editingConnectionId) || null;
  const selected = new Set(status.selectedServices || []);
  const busy = status.connecting || status.saving || status.deleting;
  const canWrite = [...selected].every((key) => services.find((service) => service.key === key)?.accessLevels?.includes("write"));

  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="google-workspace-modal-title" aria-modal="true" className="modal-panel google-workspace-modal" role="dialog">
        <div className="modal-heading">
          <div>
            <h2 id="google-workspace-modal-title">{account ? "Edit Google account" : "Add Google account"}</h2>
            <p className="subtle">{account ? account.email : "Choose the Workspace services and access level to authorize."}</p>
          </div>
          <Button aria-label="Close" icon={true} tooltip="Close" variant="secondary" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        {status.error ? <div className="error">{status.error}</div> : null}
        {status.message ? <p className="subtle">{status.message}</p> : null}
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
          </div>
        ) : <p className="empty">Google Workspace services are unavailable.</p>}
        <div className="modal-actions">
          <Button disabled={busy || !selected.size || !onStartConnection} onClick={() => onStartConnection?.({reconnect: Boolean(account)})}>
            <ExternalLink aria-hidden="true" />
            {status.connecting ? "Opening Google..." : "Start Google authorization"}
          </Button>
          <Button disabled={busy} type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </section>
    </ModalBackdrop>
  );
}
