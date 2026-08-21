import {useState} from "react";
import {Edit3, PlugZap} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {DrawerList} from "../drawers/DrawerList.jsx";
import {InspectorEditorModal} from "./InspectorEditorModal.jsx";
import {InspectorResourcePanel, InspectorResourceRow} from "./InspectorResourcePanel.jsx";

function serverEntries(config) {
  const servers = config && config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
  return Object.entries(servers).map(([name, server]) => ({name, server})).sort((left, right) => left.name.localeCompare(right.name));
}

function McpServerRow({busy, entry, onDeleteMcpServer, onEditMcpServer}) {
  const {name, server} = entry;
  const transport = server.url ? "HTTP" : "stdio";
  const detail = (
    <>
      <span className="drawer-list-row__code">{server.url || [server.command, ...(server.args || [])].filter(Boolean).join(" ")}</span>
      {server.env && Object.keys(server.env).length ? <span className="subtle">{Object.keys(server.env).length} env vars</span> : null}
    </>
  );

  return (
    <InspectorResourceRow
      busy={busy}
      detail={detail}
      meta={transport}
      resource={entry}
      title={name}
      edit={{
        disabled: !onEditMcpServer,
        icon: <Edit3 aria-hidden="true" />,
        label: `Edit ${name}`,
        onClick: (item) => onEditMcpServer?.(item),
      }}
      onDelete={{
        disabled: !onDeleteMcpServer,
        label: `Delete ${name}`,
        onClick: (item) => onDeleteMcpServer?.(item.name),
      }}
    />
  );
}

export function McpServersPanel({
  mcpServers,
  state,
  onDeleteMcpServer,
  onEditMcpServer,
  onNewMcpServer,
  onRefreshMcpServers,
  onSaveMcpServer,
  onToggleDrawerSection,
  onUpdateMcpServerForm,
}) {
  const status = mcpServers || {loading: false, saving: false, error: "", message: "", data: null, form: {}};
  const form = status.form || {};
  const entries = serverEntries(status.data);
  const transport = form.transport === "url" ? "url" : "stdio";
  const [editorOpen, setEditorOpen] = useState(false);
  const openNew = () => {
    onNewMcpServer?.();
    setEditorOpen(true);
  };
  const openEdit = (entry) => {
    onEditMcpServer?.(entry);
    setEditorOpen(true);
  };
  const closeEditor = () => {
    setEditorOpen(false);
    onNewMcpServer?.();
  };
  const submitEditor = async () => {
    const saved = await onSaveMcpServer?.();
    if (saved) setEditorOpen(false);
  };

  return (
    <InspectorResourcePanel
      className="mcp-panel"
      create={{label: "New MCP server", onClick: openNew}}
      id="right-mcp"
      description="Manage workspace MCP servers once. New sessions apply them automatically; restart an active Pi or Codex session after edits."
      refresh={{onClick: onRefreshMcpServers}}
      state={state}
      status={status}
      title="MCP Servers"
      singularLabel="MCP server"
      onToggleDrawerSection={onToggleDrawerSection}
    >
      {entries.length ? (
        <DrawerList className="mcp-list">
          {entries.map((entry) => (
            <McpServerRow
              busy={status.saving}
              entry={entry}
              key={entry.name}
              onDeleteMcpServer={onDeleteMcpServer}
              onEditMcpServer={openEdit}
            />
          ))}
        </DrawerList>
      ) : (
        <p className="empty"><PlugZap aria-hidden="true" /> No MCP servers configured for this workspace.</p>
      )}
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
          <label>
            Server name
            <input autoComplete="off" disabled={status.saving} name="name" placeholder="chrome-devtools" value={form.name || ""} onChange={(event) => onUpdateMcpServerForm?.({name: event.target.value})} />
          </label>
          <label>
            Transport
            <select disabled={status.saving} name="transport" value={transport} onChange={(event) => onUpdateMcpServerForm?.({transport: event.target.value})}>
              <option value="stdio">Command</option>
              <option value="url">URL</option>
            </select>
          </label>
          {transport === "url" ? (
            <label>
              URL
              <input autoComplete="off" disabled={status.saving} name="url" placeholder="https://example.com/mcp" value={form.url || ""} onChange={(event) => onUpdateMcpServerForm?.({url: event.target.value})} />
            </label>
          ) : (
            <>
              <label>
                Command
                <input autoComplete="off" disabled={status.saving} name="command" placeholder="npx" value={form.command || ""} onChange={(event) => onUpdateMcpServerForm?.({command: event.target.value})} />
              </label>
              <label>
                Args
                <input autoComplete="off" disabled={status.saving} name="args" placeholder="-y chrome-devtools-mcp@latest" value={form.args || ""} onChange={(event) => onUpdateMcpServerForm?.({args: event.target.value})} />
              </label>
            </>
          )}
          <label>
            Env
            <textarea disabled={status.saving} name="env" placeholder={"TOKEN=env-var-reference\nAPI_BASE=http://localhost:3000"} rows={3} value={form.env || ""} onChange={(event) => onUpdateMcpServerForm?.({env: event.target.value})} />
          </label>
        </InspectorEditorModal>
      ) : null}
    </InspectorResourcePanel>
  );
}
