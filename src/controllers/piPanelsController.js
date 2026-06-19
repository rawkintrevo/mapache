import {
  deletePiAuthProviderState,
  loadPiAuthState,
  savePiAuthProviderState,
  saveSessionPiAuthSelectionState,
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
  resetPiAuth as resetPiAuthState,
  resetPiPackages as resetPiPackagesState,
  resetWorkspaceSkills as resetWorkspaceSkillsState,
} from "../state/resetters.js";
import {sessionSkillHarness} from "../utils/sessionSkills.js";

export function createPiPanelsController({state, render}) {
  function resetPiPackages() {
    resetPiPackagesState(state);
  }

  function resetPiAuth() {
    resetPiAuthState(state);
  }

  function resetWorkspaceSkills() {
    resetWorkspaceSkillsState(state);
  }

  async function loadPiPackages() {
    await loadPiPackagesState({state, resetPiPackages, render});
  }

  async function loadWorkspaceSkills() {
    await loadWorkspaceSkillsState({state, render});
  }

  async function loadPiAuth(options = {}) {
    await loadPiAuthState({state, render, options});
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

  async function savePiAuthProvider() {
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

  async function installPiPackage(source) {
    await installPiPackageState({state, source, loadPiPackages, render});
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
    deleteWorkspaceSkill,
    editPiSkill: editWorkspaceSkill,
    editWorkspaceSkill,
    installPiPackage,
    loadPiAuth,
    loadPiPackages,
    loadPiSkills: loadWorkspaceSkills,
    loadWorkspaceSkills,
    refreshPiAuth,
    refreshPiPackages,
    refreshPiSkills: refreshWorkspaceSkills,
    refreshWorkspaceSkills,
    removePiPackage,
    resetPiAuth,
    resetPiPackages,
    resetPiSkills: resetWorkspaceSkills,
    resetWorkspaceSkills,
    savePiAuthProvider,
    savePiSkill: saveWorkspaceSkill,
    saveWorkspaceSkill,
    saveSessionPiAuthSelection,
    startOpenAiCodexDeviceLogin,
    updatePiAuthForm,
    updatePiInstallSource,
    updatePiPackage,
    updatePiSkillForm: updateWorkspaceSkillForm,
    updateWorkspaceSkillForm,
  };
}
