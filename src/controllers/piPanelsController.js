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
  installPiPackageState,
  loadPiPackagesState,
  removePiPackageState,
  updatePiInstallSourceState,
  updatePiPackageState,
} from "../workflows/piPackages.js";
import {
  cancelWorkspaceSkillEditState,
  deleteWorkspaceSkillState,
  editWorkspaceSkillState,
  loadWorkspaceSkillsState,
  saveWorkspaceSkillState,
  updateWorkspaceSkillFormState,
} from "../workflows/piSkills.js";
import {
  cancelWorkspaceSubagentEditState,
  deleteWorkspaceSubagentState,
  editWorkspaceSubagentState,
  loadWorkspaceSubagentsState,
  saveWorkspaceSubagentState,
  updateWorkspaceSubagentFormState,
} from "../workflows/subagents.js";
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
  resetPiPackages as resetPiPackagesState,
  resetWorkspaceSubagents as resetWorkspaceSubagentsState,
  resetWorkspaceSkills as resetWorkspaceSkillsState,
} from "../state/resetters.js";
import {sessionSkillHarness} from "../utils/sessionSkills.js";
import {sessionSubagentHarness} from "../utils/sessionHarnesses.js";

export function createPiPanelsController({state, render, captureSessionRequest = () => undefined}) {
  function resetPiPackages() {
    resetPiPackagesState(state);
  }

  function resetPiAuth() {
    resetPiAuthState(state);
  }

  function resetWorkspaceSkills() {
    resetWorkspaceSkillsState(state);
  }

  function resetWorkspaceSubagents() {
    resetWorkspaceSubagentsState(state);
  }

  function resetMcpServers() {
    resetMcpServersState(state);
  }

  async function loadPiPackages(request = captureSessionRequest()) {
    await loadPiPackagesState({state, resetPiPackages, render, request});
  }

  async function loadWorkspaceSkills(request = captureSessionRequest()) {
    await loadWorkspaceSkillsState({state, render, request});
  }

  async function loadPiAuth(options = {}) {
    await loadPiAuthState({state, render, options});
  }

  async function loadWorkspaceSubagents(request = captureSessionRequest()) {
    await loadWorkspaceSubagentsState({state, render, request});
  }

  async function loadMcpServers() {
    await loadMcpServersState({state, render});
  }

  async function refreshPiPackages() {
    await loadPiPackages();
  }

  async function refreshWorkspaceSkills() {
    await loadWorkspaceSkills();
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

  async function refreshWorkspaceSubagents() {
    await loadWorkspaceSubagents();
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

  function updateWorkspaceSkillForm(patch) {
    updateWorkspaceSkillFormState(state, patch);
    render();
  }

  function editWorkspaceSkill(skill) {
    editWorkspaceSkillState(state, skill);
    render();
  }

  function cancelWorkspaceSkillEdit() {
    cancelWorkspaceSkillEditState(state);
    render();
  }

  async function saveWorkspaceSkill() {
    await saveWorkspaceSkillState({state, loadWorkspaceSkills, render});
  }

  async function deleteWorkspaceSkill(name) {
    const skillName = String(name || "").trim();
    if (!skillName) return;
    const session = state.sessions.find((item) => item.id === state.selectedSessionId) || null;
    const harness = sessionSkillHarness(session);
    const path = harness ? `${harness.relativeSkillsPath}/${skillName}/SKILL.md` : `<skill-path>`;
    const ok = window.confirm(`Delete skill ${skillName}? This removes ${path} from the workspace.`);
    if (!ok) return;
    await deleteWorkspaceSkillState({state, name: skillName, loadWorkspaceSkills, render});
  }

  function updateWorkspaceSubagentForm(patch) {
    updateWorkspaceSubagentFormState(state, patch);
    render();
  }

  function editWorkspaceSubagent(subagent) {
    editWorkspaceSubagentState(state, subagent);
    render();
  }

  function cancelWorkspaceSubagentEdit() {
    cancelWorkspaceSubagentEditState(state);
    render();
  }

  async function saveWorkspaceSubagent() {
    await saveWorkspaceSubagentState({state, loadWorkspaceSubagents, render});
  }

  async function deleteWorkspaceSubagent(name) {
    const subagentName = String(name || "").trim();
    if (!subagentName) return;
    const session = state.sessions.find((item) => item.id === state.selectedSessionId) || null;
    const harness = sessionSubagentHarness(session);
    const path = harness ? `${harness.relativePath}/${subagentName}${harness.id === "codex" ? ".toml" : ".md"}` : "<subagent-path>";
    const ok = window.confirm(`Delete subagent ${subagentName}? This removes ${path} from the workspace.`);
    if (!ok) return;
    await deleteWorkspaceSubagentState({state, name: subagentName, loadWorkspaceSubagents, render});
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

  function updatePiInstallSource(source) {
    updatePiInstallSourceState(state, source);
    render();
  }

  function newPiPackage() {
    updatePiInstallSourceState(state, "");
    render();
  }

  async function installPiPackage(source) {
    return installPiPackageState({state, source, loadPiPackages, render});
  }

  async function removePiPackage(source) {
    await removePiPackageState({state, source, loadPiPackages, render});
  }

  async function updatePiPackage(source = "") {
    await updatePiPackageState({state, source, loadPiPackages, render});
  }

  return {
    cancelPiSkillEdit: cancelWorkspaceSkillEdit,
    cancelWorkspaceSkillEdit,
    deletePiAuthProvider,
    deletePiSkill: deleteWorkspaceSkill,
    deleteWorkspaceSubagent,
    deleteWorkspaceSkill,
    editPiSkill: editWorkspaceSkill,
    editWorkspaceSubagent,
    editWorkspaceSkill,
    installPiPackage,
    deleteMcpServer,
    editMcpServer,
    loadMcpServers,
    loadPiAuth,
    loadPiPackages,
    loadPiSkills: loadWorkspaceSkills,
    loadWorkspaceSubagents,
    loadWorkspaceSkills,
    refreshPiAuth,
    updateGenericEnvironmentForm,
    updateGenericEnvironmentSelection,
    editGenericEnvironmentKey,
    saveGenericEnvironmentKey,
    deleteGenericEnvironmentKey,
    refreshMcpServers,
    newMcpServer,
    newPiPackage,
    refreshPiPackages,
    refreshPiSkills: refreshWorkspaceSkills,
    refreshWorkspaceSubagents,
    refreshWorkspaceSkills,
    removePiPackage,
    resetPiAuth,
    resetMcpServers,
    resetPiPackages,
    resetPiSkills: resetWorkspaceSkills,
    resetWorkspaceSubagents,
    resetWorkspaceSkills,
    savePiAuthProvider,
    saveMcpServer,
    savePiSkill: saveWorkspaceSkill,
    saveWorkspaceSubagent,
    saveWorkspaceSkill,
    saveSessionPiAuthSelection,
    startOpenAiCodexDeviceLogin,
    updatePiAuthForm,
    updateMcpServerForm,
    updatePiInstallSource,
    updatePiPackage,
    updatePiSkillForm: updateWorkspaceSkillForm,
    updateWorkspaceSubagentForm,
    updateWorkspaceSkillForm,
    cancelWorkspaceSubagentEdit,
  };
}
