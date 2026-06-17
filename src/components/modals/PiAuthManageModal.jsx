import {useMemo, useState} from "react";
import {X} from "lucide-react";
import {piAuthProviderLabel} from "../../config/piAuthProviders.js";
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
  if (session?.piAuthSelection && typeof session.piAuthSelection === "object") return {...session.piAuthSelection};
  return Object.entries(groupedEntries).reduce((acc, [providerKey, entries]) => {
    if (entries[0]) acc[providerKey] = entries[0].id;
    return acc;
  }, {});
}

export function PiAuthManageModal({piAuth, session, onClose, onSave}) {
  const entries = useMemo(() => normalizeEntries(piAuth), [piAuth]);
  const groupedEntries = useMemo(() => groupEntries(entries), [entries]);
  const [selection, setSelection] = useState(() => initialSelection(session, groupedEntries));

  function updateProvider(providerKey, entryId) {
    setSelection((current) => {
      const next = {...current};
      if (entryId) next[providerKey] = entryId;
      else delete next[providerKey];
      return next;
    });
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="pi-auth-manage-title" aria-modal="true" className="modal-panel" role="dialog">
        <div className="modal-heading">
          <h2 id="pi-auth-manage-title">Manage Pi Auth</h2>
          <Button aria-label="Close" icon={true} tooltip="Close" variant="secondary" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        <p className="subtle">
          Choose which saved credentials should be written into this session's Pi auth.json. If Pi is already running,
          run <code>/reload</code> after saving to make the active agent reload credentials.
        </p>
        {entries.length ? (
          <div className="pi-auth-selection-list">
            {Object.entries(groupedEntries).map(([providerKey, providerEntries]) => (
              <label className="pi-auth-selection-row" key={providerKey}>
                <span>{piAuthProviderLabel(providerKey)}</span>
                <select
                  value={selection[providerKey] || ""}
                  onChange={(event) => updateProvider(providerKey, event.target.value)}
                >
                  <option value="">Do not include</option>
                  {providerEntries.map((entry) => (
                    <option key={entry.id} value={entry.id}>{entry.label || entry.id}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        ) : (
          <p className="empty">No saved Pi auth entries are available.</p>
        )}
        {piAuth.error ? <p className="empty">{piAuth.error}</p> : null}
        <div className="modal-actions">
          <Button disabled={piAuth.saving || !entries.length} onClick={() => onSave(selection)}>Save</Button>
          <Button disabled={piAuth.saving} type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </section>
    </ModalBackdrop>
  );
}
