import {PlugZap, Plus, RefreshCw, Trash2} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {DrawerList, DrawerListActionButton, DrawerListItem} from "../drawers/DrawerList.jsx";
import {DrawerSection} from "../drawers/DrawerSection.jsx";

function serverEntries(config) {
  const servers = config && config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
  return Object.entries(servers).map(([name, server]) => ({name, server})).sort((left, right) => left.name.localeCompare(right.name));
}

function McpServerRow({busy, entry, onDeleteMcpServer}) {
  const {name, server} = entry;
  const transport = server.url ? "HTTP" : "stdio";
  const detail = (
    <>
      <span className="drawer-list-row__code">{server.url || [server.command, ...(server.args || [])].filter(Boolean).join(" ")}</span>
      {server.env && Object.keys(server.env).length ? <span className="subtle">{Object.keys(server.env).length} env vars</span> : null}
    </>
  );

  return (
    <DrawerListItem
      actions={[
        <DrawerListActionButton
          disabled={busy || !onDeleteMcpServer}
          icon={<Trash2 aria-hidden="true" />}
          key="delete"
          label={"Delete " + name}
          tone="danger"
          onClick={() => onDeleteMcpServer?.(name)}
        />,
      ]}
      detail={detail}
      meta={transport}
      title={name}
    />
  );
}

export function McpServersPanel({
  mcpServers,
  state,
  onDeleteMcpServer,
  onRefreshMcpServers,
  onSaveMcpServer,
  onToggleDrawerSection,
  onUpdateMcpServerForm,
}) {
  const status = mcpServers || {loading: false, saving: false, error: "", message: "", data: null, form: {}};
  const form = status.form || {};
  const entries = serverEntries(status.data);
  const transport = form.transport === "url" ? "url" : "stdio";

  return (
    <DrawerSection
      actions={[
        <Button
          aria-label="Refresh"
          disabled={status.loading || status.saving || !onRefreshMcpServers}
          icon={true}
          key="refresh-mcp"
          size="compact"
          tooltip="Refresh"
          variant="secondary"
          onClick={onRefreshMcpServers}
        >
          <RefreshCw aria-hidden="true" />
        </Button>,
      ]}
      className="mcp-panel"
      id="right-mcp"
      state={state}
      title="MCP Servers"
      onToggleDrawerSection={onToggleDrawerSection}
    >
      <p className="subtle">
        Manage workspace MCP servers once. New sessions apply them automatically; restart an active Pi or Codex session after edits.
      </p>
      {status.error ? <p className="empty">{status.error}</p> : null}
      {status.message ? <p className="subtle">{status.message}</p> : null}
      <form
        className="mcp-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSaveMcpServer?.();
        }}
      >
        <label>
          Server name
          <input
            autoComplete="off"
            disabled={status.saving}
            name="name"
            placeholder="chrome-devtools"
            value={form.name || ""}
            onChange={(event) => onUpdateMcpServerForm?.({name: event.target.value})}
          />
        </label>
        <label>
          Transport
          <select
            disabled={status.saving}
            name="transport"
            value={transport}
            onChange={(event) => onUpdateMcpServerForm?.({transport: event.target.value})}
          >
            <option value="stdio">Command</option>
            <option value="url">URL</option>
          </select>
        </label>
        {transport === "url" ? (
          <label>
            URL
            <input
              autoComplete="off"
              disabled={status.saving}
              name="url"
              placeholder="https://example.com/mcp"
              value={form.url || ""}
              onChange={(event) => onUpdateMcpServerForm?.({url: event.target.value})}
            />
          </label>
        ) : (
          <>
            <label>
              Command
              <input
                autoComplete="off"
                disabled={status.saving}
                name="command"
                placeholder="npx"
                value={form.command || ""}
                onChange={(event) => onUpdateMcpServerForm?.({command: event.target.value})}
              />
            </label>
            <label>
              Args
              <input
                autoComplete="off"
                disabled={status.saving}
                name="args"
                placeholder="-y chrome-devtools-mcp@latest"
                value={form.args || ""}
                onChange={(event) => onUpdateMcpServerForm?.({args: event.target.value})}
              />
            </label>
          </>
        )}
        <label>
          Env
          <textarea
            disabled={status.saving}
            name="env"
            placeholder={"TOKEN=env-var-reference\nAPI_BASE=http://localhost:3000"}
            rows={3}
            value={form.env || ""}
            onChange={(event) => onUpdateMcpServerForm?.({env: event.target.value})}
          />
        </label>
        <Button
          disabled={status.saving || !onSaveMcpServer || !String(form.name || "").trim()}
          type="submit"
        >
          <Plus aria-hidden="true" />
          {status.saving ? "Saving..." : "Add MCP server"}
        </Button>
      </form>
      {entries.length ? (
        <DrawerList className="mcp-list">
          {entries.map((entry) => (
            <McpServerRow
              busy={status.saving}
              entry={entry}
              key={entry.name}
              onDeleteMcpServer={onDeleteMcpServer}
            />
          ))}
        </DrawerList>
      ) : (
        <p className="empty"><PlugZap aria-hidden="true" /> No MCP servers configured for this workspace.</p>
      )}
    </DrawerSection>
  );
}
