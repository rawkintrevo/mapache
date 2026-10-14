import {useEffect, useRef, useState} from "react";
import {X} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";
import {cancelWorkspaceUpload, MAX_UPLOAD_BYTES, uploadWorkspaceFile} from "../../services/workspaceUploads.js";
import "./ModalStack.css";
import "./WorkspaceUploadModal.css";

export function WorkspaceUploadModal({workspace, api, onClose}) {
  const [file, setFile] = useState(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [path, setPath] = useState("");
  const upload = useRef(null);
  const controller = useRef(null);
  const input = useRef(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    input.current?.focus();
    return () => {
      mounted.current = false;
      controller.current?.abort();
      void cancelWorkspaceUpload(upload.current);
    };
  }, []);

  async function start(selectedFile) {
    if (!selectedFile || busy) return;
    setError("");
    setPath("");
    if (!selectedFile.size || selectedFile.size > MAX_UPLOAD_BYTES) {
      setError("Choose a file between 1 byte and 1 GiB.");
      return;
    }
    setFile(selectedFile);
    setBusy(true);
    const abort = new AbortController();
    controller.current = abort;
    try {
      if (!upload.current) upload.current = await api.createWorkspaceUpload(workspace.id, selectedFile);
      if (abort.signal.aborted) {
        void cancelWorkspaceUpload(upload.current);
        return;
      }
      const result = await uploadWorkspaceFile(selectedFile, upload.current, {
        signal: abort.signal, onProgress: (value) => mounted.current && setProgress(value),
      });
      upload.current = null;
      if (mounted.current) setPath(result.path);
    } catch (err) {
      if (mounted.current && !abort.signal.aborted) setError(err.message || "Upload failed. Try again.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="workspace-upload-title" aria-modal="true" className="modal-panel workspace-upload-panel" role="dialog">
        <div className="modal-heading">
          <h2 id="workspace-upload-title">Upload a file</h2>
          <Button aria-label="Close upload" icon variant="secondary" onClick={onClose}><X aria-hidden="true" /></Button>
        </div>
        <p>Upload to <strong>{workspace.name}</strong>. Files are available at <code>/uploads</code> and stay saved across session restarts.</p>
        <p>Up to 1 GiB per file. If your session does not have <code>/uploads</code> yet, pause and start it once after uploading.</p>
        <label htmlFor="workspace-upload-file">Choose a file</label>
        <input disabled={busy} id="workspace-upload-file" ref={input} type="file" onChange={(event) => {
          const next = event.target.files?.[0];
          if (!next) return;
          void cancelWorkspaceUpload(upload.current);
          upload.current = null;
          setProgress(0);
          void start(next);
          event.target.value = "";
        }} />
        {busy ? <div role="status">
          <p>Uploading {file?.name}: {progress}%</p>
          <progress aria-label="Upload progress" max="100" value={progress} />
        </div> : null}
        {error ? <p role="alert">{error.replaceAll("_", " ")}</p> : null}
        {error && file && upload.current ? <Button onClick={() => start(file)}>Retry upload</Button> : null}
        {path ? <p role="status">Uploaded to <code>{path}</code></p> : null}
        <div className="modal-actions"><Button variant="secondary" onClick={onClose}>{busy ? "Cancel upload" : "Done"}</Button></div>
      </section>
    </ModalBackdrop>
  );
}
