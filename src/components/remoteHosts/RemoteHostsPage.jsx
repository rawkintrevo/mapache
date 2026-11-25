import "./RemoteHostsPage.css";
import {Check, Clipboard, KeyRound, RefreshCw, Server, ShieldCheck, Trash2, Wifi} from "lucide-react";
import {useEffect, useState} from "react";
import {Button} from "../common/Button.jsx";
import {friendlyRemoteHostError} from "../../utils/friendlyErrors.js";

export function RemoteHostsPage({state, onLoad, onRegisterHost, onTestHost, onConfirmFingerprint, onRemoveHost}) {
  const hostState = state.remoteHosts || {};
  const host = hostState.hosts?.[0] || null;
  const [form, setForm] = useState(() => ({displayName: "", address: "", port: "22", managedUsername: "mapache"}));
  const [copied, setCopied] = useState("");

  useEffect(() => {
    if (!hostState.attempted && !hostState.loading) void onLoad?.();
  }, [hostState.attempted, hostState.loading, onLoad]);

  function updateForm(event) {
    const {name, value} = event.target;
    setForm((current) => ({...current, [name]: value}));
  }

  async function submit(event) {
    event.preventDefault();
    const registered = await onRegisterHost?.({
      displayName: form.displayName.trim(),
      address: form.address.trim(),
      port: Number(form.port || 22),
      managedUsername: form.managedUsername.trim() || "mapache",
    });
    if (registered) setForm({displayName: "", address: "", port: "22", managedUsername: "mapache"});
  }

  async function copy(label, value) {
    if (!value) return;
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied((current) => current === label ? "" : current), 1800);
    } catch {
      setCopied("");
    }
  }

  return (
    <div className="remote-hosts-page">
      <header className="remote-hosts-page__header">
        <div>
          <p className="eyebrow">Remote VM infrastructure</p>
          <h2><Server aria-hidden="true" /> Remote hosts</h2>
          <p className="subtle">Connect one Ubuntu machine over its existing SSH port. Mapache creates a separate restricted key; your personal SSH private key is never requested or shown.</p>
        </div>
        <Button disabled={hostState.loading || hostState.saving || hostState.testing || hostState.removing} variant="secondary" onClick={() => onLoad?.()}>
          <RefreshCw aria-hidden="true" />
          {hostState.loading ? "Loading..." : "Refresh"}
        </Button>
      </header>

      {hostState.error ? <p className="error" role="alert">{hostState.error}</p> : null}
      {hostState.message ? <p className="remote-hosts-message" role="status">{hostState.message}</p> : null}

      {hostState.loading && !host ? (
        <section className="remote-host-card"><p className="subtle">Loading remote host...</p></section>
      ) : host ? (
        <HostCard
          copied={copied}
          host={host}
          pendingFingerprint={hostState.pendingFingerprint}
          removing={hostState.removing}
          saving={hostState.saving}
          testing={hostState.testing}
          onConfirmFingerprint={onConfirmFingerprint}
          onCopy={copy}
          onRemove={onRemoveHost}
          onTest={onTestHost}
        />
      ) : (
        <RegisterHostCard form={form} saving={hostState.saving} onChange={updateForm} onSubmit={submit} />
      )}
    </div>
  );
}

function RegisterHostCard({form, onChange, onSubmit, saving}) {
  return (
    <section aria-labelledby="remote-host-register-title" className="remote-host-card">
      <div className="remote-host-card__heading">
        <div>
          <h3 id="remote-host-register-title">Add your home machine</h3>
          <p className="subtle">Port 22 must be reachable from the internet. The setup command shown after registration installs only the Mapache VM account and helper.</p>
        </div>
        <KeyRound aria-hidden="true" />
      </div>
      <form className="remote-host-form" onSubmit={onSubmit}>
        <label><span>Display name</span><input autoComplete="off" name="displayName" placeholder="Home machine" required value={form.displayName} onChange={onChange} /></label>
        <label><span>Public hostname or IP</span><input autoComplete="off" inputMode="url" name="address" placeholder="home.example.com" required value={form.address} onChange={onChange} /></label>
        <div className="remote-host-form__row">
          <label><span>SSH port</span><input inputMode="numeric" min="1" name="port" type="number" value={form.port} onChange={onChange} /></label>
          <label><span>Managed account</span><input autoComplete="off" name="managedUsername" value={form.managedUsername} onChange={onChange} /></label>
        </div>
        <Button disabled={saving} type="submit"><Server aria-hidden="true" />{saving ? "Registering..." : "Register remote host"}</Button>
      </form>
    </section>
  );
}

function HostCard({copied, host, onConfirmFingerprint, onCopy, onRemove, onTest, pendingFingerprint, removing, saving, testing}) {
  const status = hostStatus(host);
  const setupDirections = Array.isArray(host.setupDirections) ? host.setupDirections : [];
  const directionText = [
    `Mapache public key for ${host.managedUsername || "mapache"}:`,
    host.appPublicKey || "",
    "",
    ...setupDirections.map((direction, index) => `${index + 1}. ${direction}`),
  ].filter((line) => line !== "").join("\n");
  const pending = pendingFingerprint?.hostId === (host.id || host.hostId) ? pendingFingerprint : null;
  const hostError = host.lastConnectionError ? friendlyRemoteHostError({message: host.lastConnectionError}) : "";

  return (
    <section aria-labelledby="remote-host-card-title" className="remote-host-card">
      <div className="remote-host-card__heading">
        <div>
          <h3 id="remote-host-card-title">{host.displayName || "Remote host"}</h3>
          <p className="subtle"><code>{host.managedUsername}@{host.address}:{host.port}</code></p>
        </div>
        <span className={`remote-host-status remote-host-status--${status.kind}`}>{status.label}</span>
      </div>

      {hostError ? <p className="error">{hostError}</p> : null}
      {status.kind === "ready" ? <p className="remote-host-ready"><Check aria-hidden="true" /> Host connection and readiness checks passed. Remote workspaces can use this host.</p> : null}

      <section className="remote-host-setup" aria-labelledby="remote-host-setup-title">
        <div className="remote-host-section-heading">
          <div>
            <h4 id="remote-host-setup-title">One-time host setup</h4>
            <p className="subtle">Run this on the home machine, then return here to test. Inspect the versioned scripts before using sudo.</p>
          </div>
          <Button aria-label="Copy setup directions" disabled={!directionText} variant="secondary" onClick={() => onCopy("directions", directionText)}>
            {copied === "directions" ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}
            {copied === "directions" ? "Copied" : "Copy directions"}
          </Button>
        </div>
        <div className="remote-host-key-block">
          <div className="remote-host-key-block__heading"><strong>Generated public key</strong><Button aria-label="Copy generated public key" disabled={!host.appPublicKey} variant="secondary" onClick={() => onCopy("key", host.appPublicKey)}>{copied === "key" ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}{copied === "key" ? "Copied" : "Copy key"}</Button></div>
          <code>{host.appPublicKey || "Key unavailable; refresh the host record."}</code>
        </div>
        <ol className="remote-host-directions">
          {setupDirections.map((direction) => <li key={direction}>{direction}</li>)}
        </ol>
      </section>

      {pending ? (
        <section className="remote-host-fingerprint remote-host-fingerprint--pending" aria-labelledby="remote-host-fingerprint-title">
          <div className="remote-host-section-heading">
            <div>
              <h4 id="remote-host-fingerprint-title">Verify this SSH host fingerprint</h4>
              <p className="subtle">Compare this value with the fingerprint printed by the setup/readiness command on your home machine. Only save it if they match.</p>
            </div>
            <ShieldCheck aria-hidden="true" />
          </div>
          <code className="remote-host-fingerprint-value">{pending.fingerprint}</code>
          <div className="remote-host-actions">
            <Button disabled={saving || testing} onClick={() => onConfirmFingerprint?.(host.id || host.hostId, pending.fingerprint)}><ShieldCheck aria-hidden="true" />{saving ? "Saving..." : "Trust fingerprint and test"}</Button>
            <Button disabled={saving || testing} variant="secondary" onClick={() => onTest?.(host.id || host.hostId)}>Test again</Button>
          </div>
        </section>
      ) : null}

      <div className="remote-host-actions">
        <Button disabled={testing || saving || removing} onClick={() => onTest?.(host.id || host.hostId)}><Wifi aria-hidden="true" />{testing ? "Testing SSH..." : status.kind === "ready" ? "Test again" : "Test connection"}</Button>
        <Button disabled={testing || saving || removing} variant="secondary" onClick={() => onRemove?.(host.id || host.hostId)}><Trash2 aria-hidden="true" />{removing ? "Removing..." : "Remove host"}</Button>
      </div>
      <p className="remote-host-note"><ShieldCheck aria-hidden="true" />Removing a host revokes its generated key. Hosts referenced by a remote workspace cannot be removed until that workspace is deleted.</p>
    </section>
  );
}

function hostStatus(host) {
  if (host?.ready === true || host?.status === "ready") return {kind: "ready", label: "Ready"};
  if (host?.status === "awaiting_host_key") return {kind: "pending", label: "Verify fingerprint"};
  if (host?.status === "unreachable") return {kind: "error", label: "Unreachable"};
  if (host?.status === "error") return {kind: "error", label: "Needs attention"};
  return {kind: "pending", label: "Setup required"};
}
