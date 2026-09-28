import {RefreshCw, Shield, X} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";
import {REQUEST_GRANT_PERMISSIONS} from "../../state/requestGrantsState.js";

export function WorkspaceRequestGrantsModal({grants, onClose, onLoad, onRevoke, onSave, onSetForm, onTogglePermission, selectedWorkspace, workspaces}) {
  const state = grants || {};
  const targets = (workspaces || []).filter((workspace) => workspace.id !== selectedWorkspace?.id);
  const busy = Boolean(state.loading || state.saving);
  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="workspace-request-grants-title" aria-modal="true" className="modal-panel" role="dialog">
        <div className="modal-heading">
          <div>
            <h2 id="workspace-request-grants-title">Workspace request access</h2>
            <p className="subtle">Choose which sibling workspaces this workspace may ask. Access is directional and permission-specific.</p>
          </div>
          <Button aria-label="Close" icon title="Close" variant="secondary" onClick={onClose}><X aria-hidden="true" /></Button>
        </div>
        {state.error ? <p className="error">{state.error}</p> : null}
        {state.message ? <p className="subtle">{state.message}</p> : null}
        <div className="form-field">
          <label htmlFor="request-grant-target">Target workspace</label>
          <select id="request-grant-target" disabled={busy} value={state.targetWorkspaceId || ""} onChange={(event) => onSetForm({targetWorkspaceId: event.target.value})}>
            <option value="">Select a target</option>
            {targets.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
        </div>
        <fieldset className="form-fieldset">
          <legend>Allowed operations</legend>
          {REQUEST_GRANT_PERMISSIONS.map((permission) => (
            <label className="checkbox-row" key={permission.id}>
              <input checked={state.permissions?.includes(permission.id) || false} disabled={busy} type="checkbox" onChange={() => onTogglePermission(permission.id)} />
              <span>{permission.label}</span>
            </label>
          ))}
        </fieldset>
        <div className="modal-actions">
          <Button disabled={busy || !targets.length} variant="secondary" onClick={onSave}><Shield aria-hidden="true" /> Save grant</Button>
          <Button aria-label="Refresh request grants" disabled={busy} icon title="Refresh request grants" variant="secondary" onClick={onLoad}><RefreshCw aria-hidden="true" /></Button>
          <Button variant="secondary" onClick={onClose}>Done</Button>
        </div>
        <h3>Current grants</h3>
        {state.loading ? <p className="subtle">Loading grants...</p> : state.grants?.length ? (
          <ul className="plain-list">
            {state.grants.map((grant) => {
              const target = workspaces.find((workspace) => workspace.id === grant.targetWorkspaceId);
              return <li key={grant.id || grant.targetWorkspaceId}><span>{target?.name || grant.targetWorkspaceId} · {grant.permissions.join(", ")}</span><Button disabled={busy} variant="secondary" onClick={() => onRevoke(grant.targetWorkspaceId)}>Revoke</Button></li>;
            })}
          </ul>
        ) : <p className="empty">No workspace request grants.</p>}
      </section>
    </ModalBackdrop>
  );
}
