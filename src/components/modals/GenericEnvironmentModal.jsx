import {X} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

export function GenericEnvironmentModal({piAuth, onClose, onSave, onUpdate, onEdit, onDelete}) {
  const form = piAuth.environmentForm || {};
  return <ModalBackdrop onClose={onClose}><section aria-modal="true" className="modal-panel generic-environment-panel" role="dialog">
    <div className="modal-heading"><h2>Generic environment keys</h2><Button aria-label="Close" icon={true} variant="secondary" onClick={onClose}><X /></Button></div>
    <p className="subtle">Secrets are stored privately and never shown after saving. Select keys for a session in Manage Auth.</p>
    <form className="modal-form" onSubmit={(event) => {event.preventDefault(); onSave();}}>
      <label><span>Variable name</span><input autoComplete="off" value={form.name || ""} onChange={(event) => onUpdate({name: event.target.value})} placeholder="PROVIDER_API_KEY" /></label>
      <label><span>Label</span><input autoComplete="off" value={form.label || ""} onChange={(event) => onUpdate({label: event.target.value})} placeholder="Provider API key" /></label>
      <label><span>Secret value</span><input autoComplete="new-password" type="password" value={form.value || ""} onChange={(event) => onUpdate({value: event.target.value})} placeholder={form.id ? "Enter replacement value" : "Secret value"} /></label>
      {piAuth.error ? <p className="empty">{piAuth.error}</p> : null}<div className="modal-actions"><Button disabled={piAuth.saving} type="submit">{form.id ? "Replace key" : "Save key"}</Button><Button type="button" variant="secondary" onClick={onClose}>Done</Button></div>
    </form>
    {piAuth.environmentEntries?.length ? <div className="drawer-list">{piAuth.environmentEntries.map((entry) => <div className="drawer-list-item" key={entry.id}><div><strong>{entry.label || entry.name}</strong><div className="subtle">{entry.name} · secret saved</div></div><div className="modal-actions"><Button size="compact" variant="secondary" onClick={() => onEdit(entry)}>Edit</Button><Button size="compact" variant="secondary" onClick={() => onDelete(entry.id)}>Delete</Button></div></div>)}</div> : <p className="empty">No generic environment keys saved.</p>}
  </section></ModalBackdrop>;
}
