import {useMemo, useState} from "react";
import {Pencil, Plus, Trash2, X} from "lucide-react";
import {piAuthProviderLabel} from "../../config/piAuthProviders.js";
import {sessionAuthHarness} from "../../utils/sessionHarnesses.js";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

function normalizeEntries(piAuth) {
  const entries = piAuth?.entries && typeof piAuth.entries === "object" ? piAuth.entries : {};
  const providers = piAuth?.providers && typeof piAuth.providers === "object" ? piAuth.providers : {};
  const normalized = Object.entries(entries).map(([id, entry]) => ({id, ...entry}));
  const providerKeys = new Set(normalized.map((entry) => entry.providerKey));
  Object.entries(providers).forEach(([providerKey, credential]) => {
    if (!providerKeys.has(providerKey)) normalized.push({id: `legacy-${providerKey}`, providerKey, label: piAuthProviderLabel(providerKey), credential});
  });
  return normalized.sort((left, right) => `${left.providerKey}:${left.label}`.localeCompare(`${right.providerKey}:${right.label}`));
}

function groupEntries(entries) {
  return entries.reduce((acc, entry) => {
    if (!entry.providerKey) return acc;
    if (!acc[entry.providerKey]) acc[entry.providerKey] = [];
    acc[entry.providerKey].push(entry);
    return acc;
  }, {});
}

function initialSelection(session, groupedEntries) {
  const selection = session?.authSelection?.providers && typeof session.authSelection.providers === "object" ?
    session.authSelection.providers :
      null;
  if (selection) return {...selection};
  return Object.entries(groupedEntries).reduce((acc, [providerKey, entries]) => {
    if (entries[0]) acc[providerKey] = entries[0].id;
    return acc;
  }, {});
}

export function PiAuthManageModal({piAuth, session, onAdd, onClose, onDelete, onEdit, onSave}) {
  const authHarness = sessionAuthHarness(session);
  const entries = useMemo(() => {
    const allEntries = normalizeEntries(piAuth);
    if (!authHarness?.providerKeys?.length) return allEntries;
    return allEntries.filter((entry) => authHarness.providerKeys.includes(entry.providerKey));
  }, [authHarness, piAuth]);
  const groupedEntries = useMemo(() => groupEntries(entries), [entries]);
  const [selection, setSelection] = useState(() => initialSelection(session, groupedEntries));
  function updateProvider(providerKey, entryId, checked) {
    setSelection((current) => {
      const next = {...current};
      if (checked) next[providerKey] = entryId;
      else if (next[providerKey] === entryId) delete next[providerKey];
      return next;
    });
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="pi-auth-manage-title" aria-modal="true" className="modal-panel" role="dialog">
        <div className="modal-heading">
          <h2 id="pi-auth-manage-title">{authHarness?.manageTitle || "Manage Auth"}</h2>
          <Button aria-label="Close" icon={true} tooltip="Close" variant="secondary" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        <p className="subtle">
          {authHarness?.manageDescription || "Choose which saved credentials should be written into this session auth file."}{" "}
          {authHarness?.reloadHint || ""}
        </p>
        <Button className="pi-auth-add" disabled={piAuth.loading || piAuth.saving} variant="secondary" onClick={onAdd}>
          <Plus aria-hidden="true" />
          Add authentication provider
        </Button>
        {entries.length ? (
          <div className="pi-auth-selection-list">
            {entries.map((entry) => (
              <div className="pi-auth-selection-row" key={entry.id}>
                <label className="checkbox-label">
                  <input
                    checked={selection[entry.providerKey] === entry.id}
                    disabled={piAuth.saving}
                    type="checkbox"
                    onChange={(event) => updateProvider(entry.providerKey, entry.id, event.target.checked)}
                  />
                  <span><strong>{entry.label || piAuthProviderLabel(entry.providerKey)}</strong><small>{piAuthProviderLabel(entry.providerKey)}</small></span>
                </label>
                <div className="pi-auth-selection-row__actions">
                  <Button aria-label={`Edit ${entry.label || piAuthProviderLabel(entry.providerKey)}`} disabled={piAuth.saving} icon={true} tooltip="Edit" variant="secondary" onClick={() => onEdit(entry)}><Pencil aria-hidden="true" /></Button>
                  <Button aria-label={`Delete ${entry.label || piAuthProviderLabel(entry.providerKey)}`} disabled={piAuth.saving} icon={true} tooltip="Delete" variant="secondary" onClick={() => onDelete(entry.id)}><Trash2 aria-hidden="true" /></Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty">No saved auth entries are available for this harness.</p>
        )}
        {piAuth.error ? <p className="empty">{piAuth.error}</p> : null}
        <div className="modal-actions">
          <Button disabled={piAuth.saving} onClick={() => onSave({harness: authHarness?.id || "", providers: selection})}>Save</Button>
          <Button disabled={piAuth.saving} type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </section>
    </ModalBackdrop>
  );
}
