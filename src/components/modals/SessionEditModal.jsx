import {Save, X} from "lucide-react";
import {useEffect, useState} from "react";
import {Button} from "../common/Button.jsx";
import {SessionResourceFields, SessionResourceSelector} from "../sessions/SessionResourceSelector.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

export function SessionEditModal({busy, error = "", session, onClose, onSave}) {
  const [name, setName] = useState(session.name || "");
  const [resources, setResources] = useState(session.resources || {cpu: "1", memory: "1Gi"});
  const isSshSession = session.sessionType === "ssh" || session.terminalKind === "ssh";

  useEffect(() => {
    setName(session.name || "");
    setResources(session.resources || {cpu: "1", memory: "1Gi"});
  }, [session.id, session.name, session.resources?.cpu, session.resources?.memory]);

  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="session-edit-modal-title" aria-modal="true" className="modal-panel" role="dialog">
        <div className="modal-heading">
          <h2 id="session-edit-modal-title">Edit session</h2>
          <Button aria-label="Close" icon={true} tooltip="Close" variant="secondary" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        {error ? <div className="error">{error}</div> : null}
        <form
          className="modal-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const saved = await onSave(session.id, {name: name.trim(), resources});
            if (saved) onClose();
          }}
        >
          <label>
            <span>Name</span>
            <input
              autoComplete="off"
              maxLength={256}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {isSshSession ? (
            <SessionResourceFields
              cpu={resources.cpu}
              cpuName="editSessionCpu"
              memory={resources.memory}
              memoryName="editSessionMemory"
              onChange={setResources}
            />
          ) : (
            <SessionResourceSelector
              cpu={resources.cpu}
              cpuName="editSessionCpu"
              memory={resources.memory}
              memoryName="editSessionMemory"
              onChange={setResources}
              sizeName="editSessionSize"
            />
          )}
          <div className="modal-form-actions">
            <Button disabled={busy || !name.trim()} type="submit">
              <Save aria-hidden="true" />
              Save changes
            </Button>
            <Button disabled={busy} type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      </section>
    </ModalBackdrop>
  );
}
