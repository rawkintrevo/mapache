export function createModalController({state, render, loadPiAuth}) {
  function showProfile() {
    state.activePage = "profile";
    state.sessionModalOpen = false;
    render();
  }

  function openSessionModal() {
    if (!state.selectedWorkspaceId) return;
    state.sessionModalOpen = true;
    render();
  }

  function closeSessionModal() {
    state.sessionModalOpen = false;
    render();
  }

  function openWorkspaceModal() {
    state.workspaceModalOpen = true;
    render();
  }

  function closeWorkspaceModal() {
    state.workspaceModalOpen = false;
    render();
  }

  function openWorkspaceSkillModal() {
    state.workspaceSkillModalOpen = true;
    render();
  }

  function closeWorkspaceSkillModal() {
    state.workspaceSkillModalOpen = false;
    render();
  }

  function openAuthModal(provider = "") {
    const selectedProvider = typeof provider === "string" ? provider.trim() : "";
    if (selectedProvider) {
      state.piAuth = {
        ...state.piAuth,
        selectedProvider,
        openAiCodexDevice: null,
        error: "",
        message: "",
      };
    }
    state.authModalOpen = true;
    render();
  }

  function closeAuthModal() {
    state.authModalOpen = false;
    render();
  }

  function openPiAuthManageModal() {
    state.piAuthManageModalOpen = true;
    if (!state.piAuth.loading) void loadPiAuth();
    render();
  }

  function closePiAuthManageModal() {
    state.piAuthManageModalOpen = false;
    render();
  }

  return {
    closeAuthModal,
    closePiAuthManageModal,
    closeSessionModal,
    closeWorkspaceSkillModal,
    closeWorkspaceModal,
    openAuthModal,
    openPiAuthManageModal,
    openSessionModal,
    openWorkspaceSkillModal,
    openWorkspaceModal,
    showProfile,
  };
}
