import {Plus, X} from "lucide-react";
import {sessionImages} from "../../config/sessionImages.js";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

const cpuOptions = ["1", "2", "4"];
const memoryOptions = ["1Gi", "2Gi", "4Gi", "8Gi"];

function formatMemory(value) {
  return value.replace("Gi", " GiB");
}

export function SessionModal({busy, error = "", onClose, onCreateSession}) {
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
            onCreateSession({
              name: String(formData.get("name") || "").trim() || "Terminal session",
              imageKey: formData.get("imageKey"),
              cpu: formData.get("cpu"),
              memory: formData.get("memory"),
            });
          }}
        >
          <label><span>Name</span><input autoComplete="off" name="name" placeholder="shell" required /></label>
          <label>
            <span>Container image</span>
            <select name="imageKey" defaultValue={sessionImages[0]?.key}>
              {sessionImages.map((image) => <option key={image.key} value={image.key}>{image.label}</option>)}
            </select>
          </label>
          <label><span>CPU</span><select name="cpu" defaultValue="1">{cpuOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label><span>Memory</span><select name="memory" defaultValue="1Gi">{memoryOptions.map((value) => <option key={value} value={value}>{formatMemory(value)}</option>)}</select></label>
          <Button disabled={busy} type="submit">
            <Plus aria-hidden="true" />
            Create session
          </Button>
        </form>
      </section>
    </ModalBackdrop>
  );
}
