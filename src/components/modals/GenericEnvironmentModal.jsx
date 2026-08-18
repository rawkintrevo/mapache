import {Pencil, Trash2, X} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

export function GenericEnvironmentModal({piAuth, selectedSession, onClose, onSave, onUpdate, onEdit, onDelete, onToggleSelection}) {
  const form = piAuth.environmentForm || {};
  const selectedIds = Array.isArray(selectedSession?.environmentEntryIds) ?
    selectedSession.environmentEntryIds : selectedSession?.genericEnvironmentEntryIds || [];
  return <ModalBackdrop onClose={onClose}><section aria-modal="true" className="modal-panel generic-environment-panel" role="dialog">
    <div className="modal-heading"><h2>Generic environment keys</h2><Button aria-label="Close" icon={true} variant="secondary" onClick={onClose}><X /></Button></div>
    <p className="subtle">Secrets are stored privately and never shown after saving. New keys are selected for the current session automatically; use the checkboxes below to change that selection.</p>
    <form className="modal-form" onSubmit={(event) => {event.preventDefault(); onSave();}}>
      <label><span>Variable name</span><input autoComplete="off" value={form.name || ""} onChange={(event) => onUpdate({name: event.target.value})} placeholder="PROVIDER_API_KEY" /></label>
      <label><span>Label</span><input autoComplete="off" value={form.label || ""} onChange={(event) => onUpdate({label: event.target.value})} placeholder="Provider API key" /></label>
      <label><span>Secret value</span><input autoComplete="new-password" type="password" value={form.value || ""} onChange={(event) => onUpdate({value: event.target.value})} placeholder={form.id ? "Enter replacement value" : "Secret value"} /></label>
      {piAuth.error ? <p className="empty">{piAuth.error}</p> : null}{piAuth.message ? <p className="subtle">{piAuth.message}</p> : null}<div className="generic-environment-form-actions"><Button disabled={piAuth.saving} type="submit">{form.id ? "Replace key" : "Save key"}</Button><Button type="button" variant="secondary" onClick={onClose}>Done</Button></div>
    </form>
    {piAuth.environmentEntries?.length ? <div className="generic-environment-list">{piAuth.environmentEntries.map((entry) => <div className="generic-environment-row" key={entry.id}><div className="generic-environment-row__key"><strong>{entry.label || entry.name}</strong><div className="subtle">{entry.name} · secret saved</div>{selectedSession ? <label className="generic-environment-selection"><input checked={selectedIds.includes(entry.id)} disabled={piAuth.saving} type="checkbox" onChange={(event) => onToggleSelection(entry.id, event.target.checked)} /><span>Use in {selectedSession.name || "current session"}</span></label> : null}</div><div className="generic-environment-row__actions"><Button aria-label={`Edit ${entry.name}`} icon={true} title={`Edit ${entry.name}`} variant="secondary" onClick={() => onEdit(entry)}><Pencil /></Button><Button aria-label={`Delete ${entry.name}`} className="generic-environment-delete" icon={true} title={`Delete ${entry.name}`} variant="secondary" onClick={() => onDelete(entry.id)}><Trash2 /></Button></div></div>)}</div> : <p className="empty">No generic environment keys saved.</p>}
  </section></ModalBackdrop>;
}
