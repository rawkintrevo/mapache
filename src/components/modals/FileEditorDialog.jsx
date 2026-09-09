import "./FileEditorDialog.css";
import {Save, X} from "lucide-react";
import {useEffect, useRef, useState} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {formatDate} from "../../utils/formatDate.js";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

export function FileEditorDialog({editor, onClose, onSave, onUpdateContent}) {
  const highlightRef = useRef(null);
  const [content, setContent] = useState(editor.content || "");
  const [activeTab, setActiveTab] = useState("edit");
  const isMarkdown = /\.(md|markdown)$/i.test(editor.path || editor.name || "");

  useEffect(() => {
    setContent(editor.content || "");
  }, [editor.path, editor.loading]);

  useEffect(() => {
    setActiveTab("edit");
  }, [editor.path]);

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
        {isMarkdown && !editor.loading ? (
          <div aria-label="Markdown file view" className="file-editor-tabs" role="tablist">
            <Button
              aria-controls="file-editor-edit-panel"
              aria-selected={activeTab === "edit"}
              id="file-editor-edit-tab"
              role="tab"
              size="small"
              variant={activeTab === "edit" ? "primary" : "secondary"}
              onClick={() => setActiveTab("edit")}
            >
              Edit
            </Button>
            <Button
              aria-controls="file-editor-preview-panel"
              aria-selected={activeTab === "preview"}
              id="file-editor-preview-tab"
              role="tab"
              size="small"
              variant={activeTab === "preview" ? "primary" : "secondary"}
              onClick={() => setActiveTab("preview")}
            >
              Preview
            </Button>
          </div>
        ) : null}
        {editor.loading ? (
          <div className="file-editor-status">Loading file...</div>
        ) : isMarkdown && activeTab === "preview" ? (
          <div
            aria-labelledby="file-editor-preview-tab"
            className="file-editor-preview"
            id="file-editor-preview-panel"
            role="tabpanel"
            tabIndex={0}
          >
            <Markdown
              components={{
                a: ({children, ...props}) => <a {...props} rel="noreferrer" target="_blank">{children}</a>,
              }}
              remarkPlugins={[remarkGfm]}
            >
              {content}
            </Markdown>
          </div>
        ) : (
          <div
            aria-labelledby={isMarkdown ? "file-editor-edit-tab" : undefined}
            className="file-editor-stack"
            id={isMarkdown ? "file-editor-edit-panel" : undefined}
            role={isMarkdown ? "tabpanel" : undefined}
          >
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
