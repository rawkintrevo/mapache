import "./SshGatewaysPage.css";
import {Globe, RefreshCw, Save, ShieldCheck} from "lucide-react";
import {useEffect, useState} from "react";
import {Button} from "../common/Button.jsx";

const SETUP_GUIDE_URL = "https://github.com/rawkintrevo/mapache/blob/main/docs/guides/browser-ssh-egress.md";

export function SshGatewaysPage({state, onLoad, onSaveAssignments}) {
  const gatewayState = state.sshGateways || {};
  const [drafts, setDrafts] = useState(() => draftAssignments(gatewayState.gateways));

  useEffect(() => {
    if (!gatewayState.attempted && !gatewayState.loading) void onLoad?.();
  }, [gatewayState.attempted, gatewayState.loading, onLoad]);

  useEffect(() => {
    setDrafts(draftAssignments(gatewayState.gateways));
  }, [gatewayState.gateways]);

  function toggleWorkspace(gatewayId, workspaceId) {
    setDrafts((current) => {
      const selected = new Set(current[gatewayId] || []);
      if (selected.has(workspaceId)) selected.delete(workspaceId);
      else selected.add(workspaceId);
      return {...current, [gatewayId]: [...selected]};
    });
  }

  function saveGateway(gateway) {
    void onSaveAssignments?.(gateway.id, drafts[gateway.id] || []);
  }

  return (
    <div className="ssh-gateways-page">
      <header className="ssh-gateways-page__header">
        <div>
          <p className="eyebrow">Account connections</p>
          <h2><Globe aria-hidden="true" /> SSH Gateways</h2>
          <p className="subtle">Choose which of your workspaces may use each configured SSH gateway for browser traffic.</p>
        </div>
        <Button disabled={gatewayState.loading || gatewayState.saving} variant="secondary" onClick={() => onLoad?.()}>
          <RefreshCw aria-hidden="true" />
          {gatewayState.loading ? "Loading..." : "Refresh"}
        </Button>
      </header>

      {gatewayState.error ? <p className="error" role="alert">{gatewayState.error}</p> : null}
      {gatewayState.message ? <p className="ssh-gateways-message" role="status">{gatewayState.message}</p> : null}

      {gatewayState.loading && !gatewayState.gateways?.length ? (
        <section className="ssh-gateways-card"><p className="subtle">Loading SSH gateways...</p></section>
      ) : gatewayState.gateways?.length ? (
        <>
          <div className="ssh-gateways-list">
            {gatewayState.gateways.map((gateway) => (
              <GatewayCard
                drafts={drafts}
                gateway={gateway}
                key={gateway.id}
                saving={gatewayState.saving}
                workspaces={gatewayState.workspaces || []}
                onSave={saveGateway}
                onToggleWorkspace={toggleWorkspace}
              />
            ))}
          </div>
          <p className="ssh-gateways-note">
            <ShieldCheck aria-hidden="true" /> Saved access applies when a runner is newly created or recreated. Running sessions keep their current route until you explicitly restart them; changing an assignment does not close browser windows or terminate an established tunnel.
          </p>
        </>
      ) : (
        <section className="ssh-gateways-card ssh-gateways-empty">
          <h3>No SSH gateways are configured</h3>
          <p className="subtle">There are no SSH gateways available for this account yet. Set one up first, then return here to assign it to your workspaces.</p>
          <a href={SETUP_GUIDE_URL} rel="noreferrer" target="_blank">Open SSH gateway setup documentation</a>
        </section>
      )}
    </div>
  );
}

function GatewayCard({drafts, gateway, onSave, onToggleWorkspace, saving, workspaces}) {
  const selected = drafts[gateway.id] || [];
  const savedIds = new Set(gateway.workspaceIds || []);
  const assignedNames = (gateway.workspaces || []).map((workspace) => workspace.name);
  const endpoint = `${gateway.host}:${gateway.port}`;

  return (
    <section aria-labelledby={`ssh-gateway-${gateway.id}`} className="ssh-gateways-card">
      <div className="ssh-gateway-card__header">
        <div>
          <h3 id={`ssh-gateway-${gateway.id}`}>{endpoint}</h3>
          <p className="subtle">User <code>{gateway.user}</code></p>
        </div>
        <span className={`ssh-gateway-status ssh-gateway-status--${gateway.enabled ? "enabled" : "disabled"}`}>
          {gateway.enabled ? "Available" : "Unavailable"}
        </span>
      </div>
      <div className="ssh-gateway-card__saved">
        <strong>Saved workspace access</strong>
        <span>{assignedNames.length ? assignedNames.join(", ") : "No workspace access"}</span>
      </div>
      <fieldset disabled={!gateway.enabled || saving}>
        <legend>Workspace access</legend>
        {workspaces.length ? workspaces.map((workspace) => (
          <label className="ssh-gateway-workspace-option" key={workspace.id}>
            <input
              aria-label={`Allow ${workspace.name} to use ${endpoint}`}
              checked={selected.includes(workspace.id)}
              type="checkbox"
              onChange={() => onToggleWorkspace(gateway.id, workspace.id)}
            />
            <span>{workspace.name}</span>
          </label>
        )) : <p className="subtle">Create a workspace before assigning gateway access.</p>}
      </fieldset>
      <Button disabled={!gateway.enabled || saving || sameIds(selected, savedIds)} onClick={() => onSave(gateway)}>
        <Save aria-hidden="true" />
        {saving ? "Saving..." : "Save workspace access"}
      </Button>
    </section>
  );
}

function draftAssignments(gateways = []) {
  return Object.fromEntries((gateways || []).map((gateway) => [gateway.id, [...(gateway.workspaceIds || [])]]));
}

function sameIds(values, expected) {
  const unique = new Set(values);
  return unique.size === expected.size && [...unique].every((value) => expected.has(value));
}
