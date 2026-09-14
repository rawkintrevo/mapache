import {
  deletePiAuthProviderState,
  loadPiAuthState,
  savePiAuthProviderState,
  saveSessionPiAuthSelectionState,
  saveGenericEnvironmentKeyState,
  deleteGenericEnvironmentKeyState,
  editGenericEnvironmentKeyState,
  updateGenericEnvironmentSelectionState,
  updateGenericEnvironmentFormState,
  startOpenAiCodexDeviceLoginState,
  updatePiAuthFormState,
} from "../workflows/piAuth.js";
import {
  deleteMcpServerState,
  editMcpServerFormState,
  loadMcpServersState,
  resetMcpServerFormState,
  saveMcpServerState,
  updateMcpServerFormState,
} from "../workflows/mcpServers.js";
import {
  resetMcpServers as resetMcpServersState,
  resetPiAuth as resetPiAuthState,
} from "../state/resetters.js";

export function createPiPanelsController({state, render}) {
  function resetPiAuth() {
    resetPiAuthState(state);
  }

  function resetMcpServers() {
    resetMcpServersState(state);
  }

  async function loadPiAuth(options = {}) {
    await loadPiAuthState({state, render, options});
  }

  async function loadMcpServers() {
    await loadMcpServersState({state, render});
  }

  async function refreshPiAuth() {
    await loadPiAuth({showMessage: true});
  }

  function updateGenericEnvironmentForm(patch) { updateGenericEnvironmentFormState(state, patch); render(); }
  function editGenericEnvironmentKey(entry) { editGenericEnvironmentKeyState(state, entry); render(); }
  async function saveGenericEnvironmentKey() { await saveGenericEnvironmentKeyState({state, render}); }
  async function deleteGenericEnvironmentKey(id) { await deleteGenericEnvironmentKeyState({state, entryId: id, render}); }
  async function updateGenericEnvironmentSelection(id, selected) {
    await updateGenericEnvironmentSelectionState({state, entryId: id, selected, render});
  }

  async function refreshMcpServers() {
    await loadMcpServers();
  }

  function updateMcpServerForm(patch) {
    updateMcpServerFormState(state, patch);
    render();
  }

  function newMcpServer() {
    resetMcpServerFormState(state);
    render();
  }

  function editMcpServer(entry) {
    editMcpServerFormState(state, entry);
    render();
  }

  async function saveMcpServer() {
    return saveMcpServerState({state, loadMcpServers, render});
  }

  async function deleteMcpServer(name) {
    const serverName = String(name || "").trim();
    if (!serverName) return;
    const ok = window.confirm(`Delete MCP server ${serverName}? Restart active sessions after deleting to apply the change.`);
    if (!ok) return;
    await deleteMcpServerState({state, name: serverName, loadMcpServers, render});
  }

  function updatePiAuthForm(patch) {
    updatePiAuthFormState(state, patch);
    render();
  }

  async function deletePiAuthProvider(provider) {
    const providerKey = String(provider || "").trim();
    if (!providerKey) return;
    const ok = window.confirm(`Delete Pi auth provider ${providerKey}? New sessions will no longer receive this credential.`);
    if (!ok) return;
    await deletePiAuthProviderState({state, provider: providerKey, render});
  }

  async function startOpenAiCodexDeviceLogin() {
    await startOpenAiCodexDeviceLoginState({state, render});
  }

  async function savePiAuthProvider(provider, apiKey, entryLabel) {
    updatePiAuthFormState(state, {
      selectedProvider: provider,
      apiKey,
      entryLabel,
    });
    await savePiAuthProviderState({state, render});
  }

  async function saveSessionPiAuthSelection(selection) {
    const session = state.sessions.find((item) => item.id === state.selectedSessionId);
    await saveSessionPiAuthSelectionState({state, session, selection, render});
  }

  return {
    deletePiAuthProvider,
    deleteMcpServer,
    editMcpServer,
    loadMcpServers,
    loadPiAuth,
    refreshPiAuth,
    updateGenericEnvironmentForm,
    updateGenericEnvironmentSelection,
    editGenericEnvironmentKey,
    saveGenericEnvironmentKey,
    deleteGenericEnvironmentKey,
    refreshMcpServers,
    newMcpServer,
    resetPiAuth,
    resetMcpServers,
    savePiAuthProvider,
    saveMcpServer,
    saveSessionPiAuthSelection,
    startOpenAiCodexDeviceLogin,
    updatePiAuthForm,
    updateMcpServerForm,
  };
}
