import {Plus, X} from "lucide-react";
import {sessionImages} from "../../config/sessionImages.js";
import {parseEnvText} from "../../utils/envText.js";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

const cpuOptions = ["1", "2", "4"];
const memoryOptions = ["1Gi", "2Gi", "4Gi", "8Gi"];

function formatMemory(value) {
  return value.replace("Gi", " GiB");
}

export function SessionModal({busy, error = "", selectedWorkspace = null, onClose, onCreateSession}) {
  const workspaceSsh = selectedWorkspace?.source?.type === "ssh";
  const sessionType = workspaceSsh ? "ssh" : "cloud";
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
            const base = {
              name: String(formData.get("name") || "").trim() || "Terminal session",
              sessionType,
              cpu: formData.get("cpu"),
              memory: formData.get("memory"),
              env: parseEnvText(formData.get("env")),
            };
            onCreateSession(sessionType === "ssh" ? {
              ...base,
            } : {
              ...base,
              imageKey: formData.get("imageKey"),
            });
          }}
        >
          <label><span>Name</span><input autoComplete="off" name="name" placeholder="shell" required /></label>
          {sessionType === "cloud" ? (
            <label>
              <span>Container image</span>
              <select name="imageKey" defaultValue={sessionImages[0]?.key}>
                {sessionImages.map((image) => <option key={image.key} value={image.key}>{image.label}</option>)}
              </select>
            </label>
          ) : workspaceSsh ? (
            <div className="workspace-source-fields">
              <p className="subtle">
                This session will connect to {selectedWorkspace.source?.target?.username}@{selectedWorkspace.source?.target?.host}.
              </p>
            </div>
          ) : null}
          <label><span>CPU</span><select name="cpu" defaultValue="1">{cpuOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label><span>Memory</span><select name="memory" defaultValue="1Gi">{memoryOptions.map((value) => <option key={value} value={value}>{formatMemory(value)}</option>)}</select></label>
          <label>
            <span>Session env</span>
            <textarea name="env" placeholder={"FOO=session-value\nAPI_BASE=http://localhost:3000"} rows={4} />
          </label>
          <Button disabled={busy} type="submit">
            <Plus aria-hidden="true" />
            Create session
          </Button>
        </form>
      </section>
    </ModalBackdrop>
  );
}
