import {friendlyMcpConfigError} from "../utils/friendlyErrors.js";
import {parseEnvText} from "../utils/envText.js";

function currentServers(state) {
  const data = state.mcpServers?.data;
  return data && data.mcpServers && typeof data.mcpServers === "object" ? data.mcpServers : {};
}

function resetForm() {
  return {
    name: "",
    transport: "stdio",
    command: "",
    args: "",
    url: "",
    env: "",
  };
}

export function updateMcpServerFormState(state, patch) {
  state.mcpServers = {
    ...state.mcpServers,
    error: "",
    message: "",
    form: {
      ...state.mcpServers.form,
      ...patch,
    },
  };
}

export async function loadMcpServersState({state, render}) {
  const workspaceId = state.selectedWorkspaceId;
  if (!workspaceId) {
    state.mcpServers = {...state.mcpServers, loading: false, data: null, error: "Select a workspace to manage MCP servers."};
    render();
    return;
  }

  state.mcpServers = {...state.mcpServers, loading: true, error: "", message: ""};
  render();
  try {
    const data = await state.api.getWorkspaceMcpConfig(workspaceId);
    state.mcpServers = {...state.mcpServers, loading: false, data: data || {mcpServers: {}}, error: ""};
  } catch (error) {
    state.mcpServers = {...state.mcpServers, loading: false, error: friendlyMcpConfigError(error)};
  }
  render();
}

export async function saveMcpServerState({state, loadMcpServers, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const form = state.mcpServers.form || {};
  const name = String(form.name || "").trim().toLowerCase();
  const transport = form.transport === "url" ? "url" : "stdio";
  if (!workspaceId || !name) {
    state.mcpServers = {...state.mcpServers, error: name ? "Select a workspace before saving MCP servers." : "Enter an MCP server name."};
    render();
    return;
  }

  const server = transport === "url" ?
    {url: String(form.url || "").trim()} :
    {
      command: String(form.command || "").trim(),
      args: String(form.args || "").split(/\s+/).map((item) => item.trim()).filter(Boolean),
    };
  const env = parseEnvText(form.env || "");
  if (Object.keys(env).length) server.env = env;

  state.mcpServers = {...state.mcpServers, saving: true, error: "", message: "Saving MCP server..."};
  render();
  try {
    await state.api.saveWorkspaceMcpConfig(workspaceId, {
      mcpServers: {
        ...currentServers(state),
        [name]: server,
      },
    });
    state.mcpServers = {...state.mcpServers, saving: false, form: resetForm(), message: "MCP server saved. Restart active sessions to apply changes."};
    await loadMcpServers();
  } catch (error) {
    state.mcpServers = {...state.mcpServers, saving: false, error: friendlyMcpConfigError(error), message: ""};
    render();
  }
}

export async function deleteMcpServerState({state, name, loadMcpServers, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const serverName = String(name || "").trim();
  if (!workspaceId || !serverName) return;
  const nextServers = {...currentServers(state)};
  delete nextServers[serverName];

  state.mcpServers = {...state.mcpServers, saving: true, error: "", message: "Removing MCP server..."};
  render();
  try {
    await state.api.saveWorkspaceMcpConfig(workspaceId, {mcpServers: nextServers});
    state.mcpServers = {...state.mcpServers, saving: false, message: "MCP server removed. Restart active sessions to apply changes."};
    await loadMcpServers();
  } catch (error) {
    state.mcpServers = {...state.mcpServers, saving: false, error: friendlyMcpConfigError(error), message: ""};
    render();
  }
}
