import {Plus, X} from "lucide-react";
import {useState} from "react";
import {parseEnvText} from "../../utils/envText.js";
import {getDefaultSessionResources} from "../../utils/sessionResources.js";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";
import {SessionResourceSelector} from "../sessions/SessionResourceSelector.jsx";

export function SessionModal({busy, error = "", selectedWorkspace = null, environmentEntries = [], onClose, onCreateSession}) {
  const workspaceSsh = selectedWorkspace?.source?.type === "ssh";
  const sessionType = "cloud";
  const [resources, setResources] = useState(() => getDefaultSessionResources());
  if (workspaceSsh) {
    return (
      <ModalBackdrop onClose={onClose}>
        <section aria-labelledby="session-modal-title" aria-modal="true" className="modal-panel" role="dialog">
          <div className="modal-heading">
            <h2 id="session-modal-title">New session</h2>
            <Button aria-label="Close" icon={true} tooltip="Close" variant="secondary" onClick={onClose}>
              <X aria-hidden="true" />
            </Button>
          </div>
          <div className="workspace-source-fields">
            <p className="subtle">Dev machine workspaces are historical and cannot start new sessions.</p>
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
        </section>
      </ModalBackdrop>
    );
  }
  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="session-modal-title" aria-modal="true" className="modal-panel" role="dialog">
        <div className="modal-heading">
          <h2 id="session-modal-title">New session</h2>
          <Button aria-label="Close" icon={true} tooltip="Close" variant="secondary" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        {error ? <div className="error">{error}</div> : null}
        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            const environmentEntryIds = formData.getAll("environmentEntryId");
            const base = {
              name: String(formData.get("name") || "").trim() || "Terminal session",
              sessionType,
              cpu: formData.get("cpu"),
              memory: formData.get("memory"),
              env: parseEnvText(formData.get("env")),
            };
            if (environmentEntryIds.length) base.environmentEntryIds = environmentEntryIds;
            onCreateSession(base);
          }}
        >
          <label><span>Name</span><input autoComplete="off" name="name" placeholder="shell" required /></label>
          <SessionResourceSelector
            cpu={resources.cpu}
            memory={resources.memory}
            onChange={setResources}
          />
          <label>
            <span>Session env</span>
            <textarea name="env" placeholder={"FOO=session-value\nAPI_BASE=http://localhost:3000"} rows={4} />
          </label>
          {environmentEntries.length ? <fieldset><legend>Saved generic environment keys</legend>{environmentEntries.map((entry) => <label className="checkbox-label" key={entry.id}><input name="environmentEntryId" type="checkbox" value={entry.id} /><span>{entry.label || entry.name} ({entry.name})</span></label>)}<p className="subtle">Secrets are injected when this runner is provisioned.</p></fieldset> : null}
          <Button disabled={busy} type="submit">
            <Plus aria-hidden="true" />
            Create session
          </Button>
        </form>
      </section>
    </ModalBackdrop>
  );
}
