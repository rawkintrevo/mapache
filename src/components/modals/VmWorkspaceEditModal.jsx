import {useEffect, useRef, useState} from "react";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";
import {piAuthProviderLabel} from "../../config/piAuthProviders.js";
import {SessionResourceSelector} from "../sessions/SessionResourceSelector.jsx";

const DEFAULT_VM_RESOURCES = {cpu: "2", memory: "8Gi"};

function message(error) {
  if (/vm_configuration_version_mismatch|vm_generation_mismatch/.test(error.message || "")) return "This workspace changed since you opened its settings. Reload saved settings before saving again.";
  if (/vm_operation_in_progress/.test(error.message || "")) return "The workspace is starting or stopping. Wait for it to finish, then reload saved settings.";
  if (/vm_auth_entry_unavailable|vm_environment_entry_unavailable/.test(error.message || "")) return "A selected credential or variable is no longer available. Reload saved settings and update your selections.";
  if (/invalid_session_resources|invalid_vm_disk_size_gb|invalid_vm_idle_stop_minutes|invalid_vm_description/.test(error.message || "")) return "Choose supported VM settings and save again.";
  if (/vm_disk_shrink_unsupported/.test(error.message || "")) return "Durable disk size can only grow. Reload saved settings and choose a larger size.";
  return "Could not load or save workspace settings. Please try again.";
}

export function VmWorkspaceEditModal({workspace, api, onClose}) {
  const [config, setConfig] = useState(null);
  const [providers, setProviders] = useState({});
  const [environmentIds, setEnvironmentIds] = useState([]);
  const [entries, setEntries] = useState([]);
  const [environment, setEnvironment] = useState([]);
  const [resources, setResources] = useState(DEFAULT_VM_RESOURCES);
  const [resourcesChanged, setResourcesChanged] = useState(false);
  const [diskSizeGb, setDiskSizeGb] = useState("");
  const [description, setDescription] = useState("");
  const [idleStopMinutes, setIdleStopMinutes] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const sequence = useRef(0);
  async function reload() {
    const request = ++sequence.current;
    setBusy(true); setError(""); setSaved(false);
    try {
      const [next, auth, env] = await Promise.all([api.getMachineConfiguration(workspace.id), api.getPiAuth(), api.getGenericEnvironmentKeys()]);
      if (request !== sequence.current) return;
      setConfig(next); setProviders({...next.desired.authSelection.providers});
      setEnvironmentIds([...next.desired.environmentEntryIds]);
      setResources(next.desired.resources || DEFAULT_VM_RESOURCES); setResourcesChanged(false);
      setDiskSizeGb(next.desired.diskSizeGb == null ? "" : String(next.desired.diskSizeGb));
      setDescription(next.desired.description || "");
      setIdleStopMinutes(next.desired.idleStopMinutes == null ? "" : String(next.desired.idleStopMinutes));
      const available = Object.entries(auth.entries || {}).map(([id, entry]) => ({id, providerKey: entry.providerKey, label: entry.label}));
      for (const providerKey of Object.keys(auth.providers || {})) {
        if (!available.some(entry => entry.providerKey === providerKey)) available.push({id: `legacy-${providerKey}`, providerKey, label: piAuthProviderLabel(providerKey)});
      }
      setEntries(available); setEnvironment(env.entries || []);
    } catch (failure) { if (request === sequence.current) setError(message(failure)); }
    finally { if (request === sequence.current) setBusy(false); }
  }
  useEffect(() => {
    void reload();
    return () => { sequence.current++; };
  }, [workspace.id, api]);
  async function save(event) {
    event.preventDefault();
    const request = sequence.current;
    setBusy(true); setError(""); setSaved(false);
    try {
      const patch = {
        expectedGeneration: config.generation, expectedVersion: config.desiredVersion,
        authSelection: {harness: "pi", providers}, environmentEntryIds: environmentIds,
        description: description.trim(),
        idleStopMinutes: idleStopMinutes === "" ? null : Number(idleStopMinutes),
      };
      if (diskSizeGb !== "" || config.desired.diskSizeGb != null) patch.diskSizeGb = diskSizeGb === "" ? null : Number(diskSizeGb);
      if (resourcesChanged || config.desired.resources) patch.resources = resources;
      const next = await api.updateMachineConfiguration(workspace.id, patch);
      if (request === sequence.current) { setConfig(next); setSaved(true); }
    } catch (failure) { if (request === sequence.current) setError(message(failure)); }
    finally { if (request === sequence.current) setBusy(false); }
  }
  const keys = [...new Set([...entries.map(entry => entry.providerKey), ...Object.keys(providers)])].filter(Boolean).sort();
  const variables = [...environment, ...environmentIds.filter(id => !environment.some(entry => entry.id === id))
      .map(id => ({id, label: "Unavailable saved variable"}))];
  return <ModalBackdrop onClose={onClose}>
    <section aria-labelledby="vm-settings-title" aria-modal="true" className="modal-panel" role="dialog">
      <div className="modal-heading"><h2 id="vm-settings-title">Settings for {workspace.name}</h2>
        <Button aria-label="Close" variant="secondary" onClick={onClose}>Close</Button></div>
      <p>Selections apply on the next start or restart. Saving does not interrupt the running agent or start a stopped workspace.</p>
      {error ? <div role="alert" className="error">{error}</div> : null}
      {config ? <p role="status">{saved ? "Saved. " : ""}{config.restartRequired ? "Restart required to apply saved settings." : config.state === "applied" ? "Saved settings are applied." : "Current settings have not been tracked as an applied revision yet."}</p> : null}
      {busy ? <p role="status">Working…</p> : null}
      {config ? <form className="modal-form" onSubmit={save}>
        <fieldset disabled={busy}><legend>Machine details</legend>
          <label><span>Description</span>
            <textarea maxLength="1000" value={description} onChange={event => {setSaved(false); setDescription(event.target.value);}} />
          </label>
          <label><span>Idle stop minutes (5–1440)</span>
            <input inputMode="numeric" min="5" max="1440" type="number" value={idleStopMinutes} onChange={event => {setSaved(false); setIdleStopMinutes(event.target.value);}} />
          </label>
          <p className="subtle">When set, an active VM pauses after this much activity-free time, provided no terminal or browser connection is open. The control-plane scheduler checks about once per minute.</p>
        </fieldset>
        <fieldset disabled={busy}><legend>Compute Engine resources</legend>
          <SessionResourceSelector cpu={resources.cpu} memory={resources.memory} onChange={next => {
            setSaved(false); setResources(next); setResourcesChanged(true);
          }} pricingMode="compute-engine" sizeName="vmSize" />
          {!config.desired.resources ? <p className="subtle">Current legacy VM type is e2-standard-2. Choose a size to opt into the validated E2 custom machine-type path.</p> : null}
          <label><span>Durable disk size (GiB, 10–4096)</span>
            <input inputMode="numeric" min="10" max="4096" type="number" value={diskSizeGb} onChange={event => {setSaved(false); setDiskSizeGb(event.target.value);}} />
          </label>
        </fieldset>
        <fieldset disabled={busy}><legend>Provider credentials</legend>
          {!keys.length ? <p>No saved provider credentials.</p> : keys.map(key => <label key={key}>
            <span>{piAuthProviderLabel(key)}</span>
            <select aria-label={`${piAuthProviderLabel(key)} credential`} value={providers[key] || ""} onChange={event => {
              setSaved(false); const next = {...providers};
              if (event.target.value) next[key] = event.target.value; else delete next[key];
              setProviders(next);
            }}><option value="">None</option>
              {providers[key] && !entries.some(entry => entry.id === providers[key] && entry.providerKey === key) ? <option value={providers[key]}>Unavailable saved credential</option> : null}
              {entries.filter(entry => entry.providerKey === key).map(entry => <option key={entry.id} value={entry.id}>{entry.label || piAuthProviderLabel(key)}</option>)}
            </select>
          </label>)}
        </fieldset>
        <fieldset disabled={busy}><legend>Environment variables</legend>
          {!variables.length ? <p>No saved environment variables.</p> : variables.map(entry => <label className="checkbox-label" key={entry.id}>
            <input type="checkbox" checked={environmentIds.includes(entry.id)} onChange={event => {
              setSaved(false); setEnvironmentIds(event.target.checked ? [...environmentIds, entry.id] : environmentIds.filter(id => id !== entry.id));
            }} />{entry.label || entry.name}{entry.label && entry.name ? ` (${entry.name})` : ""}
          </label>)}
        </fieldset>
        <div className="modal-form-actions"><Button disabled={busy} type="submit">Save settings</Button></div>
      </form> : null}
      <Button disabled={busy} variant="secondary" onClick={reload}>Reload saved settings</Button>
    </section>
  </ModalBackdrop>;
}
