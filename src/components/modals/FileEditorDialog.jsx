import "./FileEditorDialog.css";
import {Save, X} from "lucide-react";
import {useEffect, useRef, useState} from "react";
import {formatDate} from "../../utils/formatDate.js";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

export function FileEditorDialog({editor, onClose, onSave, onUpdateContent}) {
  const highlightRef = useRef(null);
  const [content, setContent] = useState(editor.content || "");

  useEffect(() => {
    setContent(editor.content || "");
  }, [editor.path, editor.content, editor.loading]);

  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="file-editor-title" aria-modal="true" className="modal-panel file-editor-panel" role="dialog">
        <div className="modal-heading">
          <div className="file-editor-title">
            <h2 id="file-editor-title">{editor.name || "File"}</h2>
            <span>{editor.path}</span>
          </div>
          <Button aria-label="Close editor" icon={true} title="Close editor" tooltip="Close editor" variant="secondary" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        {editor.error ? <div className="error">{editor.error}</div> : null}
        {editor.loading ? (
          <div className="file-editor-status">Loading file...</div>
        ) : (
          <div className="file-editor-stack">
            <pre aria-hidden="true" className="file-editor-highlight" ref={highlightRef}>{content}</pre>
            <textarea
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              className="file-editor-input"
              disabled={editor.loading || editor.saving}
              spellCheck={false}
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                onUpdateContent(event.target.value);
              }}
              onScroll={(event) => {
                if (!highlightRef.current) return;
                highlightRef.current.scrollTop = event.currentTarget.scrollTop;
                highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
              }}
            />
          </div>
        )}
        <div className="file-editor-actions">
          {editor.updatedAt ? <span className="subtle">Updated {formatDate(editor.updatedAt)}</span> : <span className="subtle" />}
          <Button className="file-editor-save" disabled={editor.loading || editor.saving} onClick={() => onSave(content)}>
            <Save aria-hidden="true" />
            <span>{editor.saving ? "Saving" : "Save"}</span>
          </Button>
        </div>
      </section>
    </ModalBackdrop>
  );
}
