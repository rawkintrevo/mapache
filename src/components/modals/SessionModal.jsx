import {sessionImages} from "../../config/sessionImages.js";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

const cpuOptions = ["1", "2", "4"];
const memoryOptions = ["1Gi", "2Gi", "4Gi", "8Gi"];

function formatMemory(value) {
  return value.replace("Gi", " GiB");
}

export function SessionModal({busy, onClose, onCreateSession}) {
  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="session-modal-title" aria-modal="true" className="modal-panel" role="dialog">
        <div className="modal-heading">
          <h2 id="session-modal-title">New session</h2>
          <button aria-label="Close" className="icon-button close-button secondary" type="button" onClick={onClose}>×</button>
        </div>
        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            onCreateSession({
              name: String(formData.get("name") || "").trim() || "Terminal session",
              image: formData.get("image"),
              cpu: formData.get("cpu"),
              memory: formData.get("memory"),
            });
          }}
        >
          <label><span>Name</span><input autoComplete="off" name="name" placeholder="shell" required /></label>
          <label>
            <span>Container image</span>
            <select name="image" defaultValue={sessionImages[0]?.value}>
              {sessionImages.map((image) => <option key={image.value} value={image.value}>{image.label}</option>)}
            </select>
          </label>
          <label><span>CPU</span><select name="cpu" defaultValue="1">{cpuOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label><span>Memory</span><select name="memory" defaultValue="1Gi">{memoryOptions.map((value) => <option key={value} value={value}>{formatMemory(value)}</option>)}</select></label>
          <button disabled={busy} type="submit">Create session</button>
        </form>
      </section>
    </ModalBackdrop>
  );
}
