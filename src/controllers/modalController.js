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

  function openAuthModal() {
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
    closeWorkspaceModal,
    openAuthModal,
    openPiAuthManageModal,
    openSessionModal,
    openWorkspaceModal,
    showProfile,
  };
}
