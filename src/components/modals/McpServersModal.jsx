import {Edit3, Plus, RefreshCw, Trash2, X} from "lucide-react";
import {useState} from "react";
import "../drawers/Drawers.css";
import "../inspector/InspectorPanels.css";
import {Button} from "../common/Button.jsx";
import {DrawerList, DrawerListActionButton, DrawerListItem} from "../drawers/DrawerList.jsx";
import {InspectorEditorModal} from "../inspector/InspectorEditorModal.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

function serverEntries(config) {
  const servers = config?.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
  return Object.entries(servers).map(([name, server]) => ({name, server})).sort((left, right) => left.name.localeCompare(right.name));
}

export function McpServersModal({mcpServers, onClose, onDelete, onEdit, onNew, onRefresh, onSave, onUpdate}) {
  const status = mcpServers || {loading: false, saving: false, error: "", message: "", data: null, form: {}};
  const form = status.form || {};
  const transport = form.transport === "url" ? "url" : "stdio";
  const entries = serverEntries(status.data);
  const [editorOpen, setEditorOpen] = useState(false);
  const closeEditor = () => {
    setEditorOpen(false);
    onNew?.();
  };
  const submitEditor = async () => {
    if (await onSave?.()) setEditorOpen(false);
  };

  return (
    <>
      <ModalBackdrop onClose={onClose}>
        <section aria-labelledby="mcp-servers-modal-title" aria-modal="true" className="modal-panel mcp-servers-panel" role="dialog">
          <div className="modal-heading">
            <div>
              <h2 id="mcp-servers-modal-title">MCP Servers</h2>
              <p className="subtle">Manage servers for the selected workspace. Restart an active session after changes.</p>
            </div>
            <Button aria-label="Close" icon title="Close" variant="secondary" onClick={onClose}><X aria-hidden="true" /></Button>
          </div>
          <div className="mcp-servers-toolbar">
            <Button disabled={status.loading || status.saving} variant="secondary" onClick={() => { onNew?.(); setEditorOpen(true); }}>
              <Plus aria-hidden="true" /> New MCP server
            </Button>
            <Button aria-label="Refresh MCP servers" disabled={status.loading || status.saving || !onRefresh} icon title="Refresh MCP servers" variant="secondary" onClick={onRefresh}>
              <RefreshCw aria-hidden="true" />
            </Button>
          </div>
          {status.error ? <p className="error">{status.error}</p> : null}
          {status.message ? <p className="subtle">{status.message}</p> : null}
          {entries.length ? (
            <DrawerList className="mcp-list">
              {entries.map(({name, server}) => (
                <DrawerListItem
                  actions={[
                    <DrawerListActionButton disabled={status.saving} icon={<Edit3 aria-hidden="true" />} key="edit" label={`Edit ${name}`} onClick={() => { onEdit?.({name, server}); setEditorOpen(true); }} />,
                    <DrawerListActionButton disabled={status.saving} icon={<Trash2 aria-hidden="true" />} key="delete" label={`Delete ${name}`} tone="danger" onClick={() => onDelete?.(name)} />,
                  ]}
                  detail={server.env && Object.keys(server.env).length ? <span className="subtle">{Object.keys(server.env).length} env vars</span> : null}
                  key={name}
                  meta={server.url ? "HTTP" : "stdio"}
                  title={name}
                >
                  <span className="drawer-list-row__code">{server.url || [server.command, ...(server.args || [])].filter(Boolean).join(" ")}</span>
                </DrawerListItem>
              ))}
            </DrawerList>
          ) : status.loading ? <p className="subtle">Loading MCP servers...</p> : <p className="empty">No MCP servers configured for this workspace.</p>}
          <div className="modal-actions"><Button variant="secondary" onClick={onClose}>Done</Button></div>
        </section>
      </ModalBackdrop>
      {editorOpen ? (
        <InspectorEditorModal
          description="MCP servers are shared by the selected workspace. Restart active sessions after saving to apply changes."
          error={status.error}
          message={status.message}
          onClose={closeEditor}
          onSubmit={submitEditor}
          saving={status.saving}
          submitLabel={form.editing ? "Save MCP server" : "Add MCP server"}
          title={form.editing ? "Edit MCP server" : "New MCP server"}
        >
          <label>Server name<input autoComplete="off" disabled={status.saving} name="name" placeholder="chrome-devtools" value={form.name || ""} onChange={(event) => onUpdate?.({name: event.target.value})} /></label>
          <label>Transport<select disabled={status.saving} name="transport" value={transport} onChange={(event) => onUpdate?.({transport: event.target.value})}><option value="stdio">Command</option><option value="url">URL</option></select></label>
          {transport === "url" ? (
            <label>URL<input autoComplete="off" disabled={status.saving} name="url" placeholder="https://example.com/mcp" value={form.url || ""} onChange={(event) => onUpdate?.({url: event.target.value})} /></label>
          ) : (
            <><label>Command<input autoComplete="off" disabled={status.saving} name="command" placeholder="npx" value={form.command || ""} onChange={(event) => onUpdate?.({command: event.target.value})} /></label><label>Args<input autoComplete="off" disabled={status.saving} name="args" placeholder="-y chrome-devtools-mcp@latest" value={form.args || ""} onChange={(event) => onUpdate?.({args: event.target.value})} /></label></>
          )}
          <label>Env<textarea disabled={status.saving} name="env" placeholder={"TOKEN=env-var-reference\nAPI_BASE=http://localhost:3000"} rows={3} value={form.env || ""} onChange={(event) => onUpdate?.({env: event.target.value})} /></label>
        </InspectorEditorModal>
      ) : null}
    </>
  );
}
