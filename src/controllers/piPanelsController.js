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
  cancelPiSkillEditState,
  deletePiSkillState,
  editPiSkillState,
  loadPiSkillsState,
  savePiSkillState,
  updatePiSkillFormState,
} from "../workflows/piSkills.js";
import {
  resetPiAuth as resetPiAuthState,
  resetPiPackages as resetPiPackagesState,
  resetPiSkills as resetPiSkillsState,
} from "../state/resetters.js";

export function createPiPanelsController({state, render}) {
  function resetPiPackages() {
    resetPiPackagesState(state);
  }

  function resetPiAuth() {
    resetPiAuthState(state);
  }

  function resetPiSkills() {
    resetPiSkillsState(state);
  }

  async function loadPiPackages() {
    await loadPiPackagesState({state, resetPiPackages, render});
  }

  async function loadPiSkills() {
    await loadPiSkillsState({state, render});
  }

  async function loadPiAuth(options = {}) {
    await loadPiAuthState({state, render, options});
  }

  async function refreshPiPackages() {
    await loadPiPackages();
  }

  async function refreshPiSkills() {
    await loadPiSkills();
  }

  async function refreshPiAuth() {
    await loadPiAuth({showMessage: true});
  }

  function updatePiSkillForm(patch) {
    updatePiSkillFormState(state, patch);
    render();
  }

  function editPiSkill(skill) {
    editPiSkillState(state, skill);
    render();
  }

  function cancelPiSkillEdit() {
    cancelPiSkillEditState(state);
    render();
  }

  async function savePiSkill() {
    await savePiSkillState({state, loadPiSkills, render});
  }

  async function deletePiSkill(name) {
    const skillName = String(name || "").trim();
    if (!skillName) return;
    const ok = window.confirm(`Delete Pi skill ${skillName}? This removes .pi/skills/${skillName}/SKILL.md from the workspace.`);
    if (!ok) return;
    await deletePiSkillState({state, name: skillName, loadPiSkills, render});
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
    cancelPiSkillEdit,
    deletePiAuthProvider,
    deletePiSkill,
    editPiSkill,
    installPiPackage,
    loadPiAuth,
    loadPiPackages,
    loadPiSkills,
    refreshPiAuth,
    refreshPiPackages,
    refreshPiSkills,
    removePiPackage,
    resetPiAuth,
    resetPiPackages,
    resetPiSkills,
    savePiAuthProvider,
    savePiSkill,
    saveSessionPiAuthSelection,
    startOpenAiCodexDeviceLogin,
    updatePiAuthForm,
    updatePiInstallSource,
    updatePiPackage,
    updatePiSkillForm,
  };
}
