import {APP_ACTIONS} from "../state/appStore.js";

export function createModalController({state, dispatch = () => {}, render, loadPiAuth, loadPiModels}) {
  function showProfile() {
    dispatch({type: APP_ACTIONS.SET_ACTIVE_PAGE, page: "profile"});
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

  function openWorkspaceSubagentModal() {
    state.workspaceSubagentModalOpen = true;
    render();
  }

  function closeWorkspaceSubagentModal() {
    state.workspaceSubagentModalOpen = false;
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

  function openGenericEnvironmentModal() {
    state.genericEnvironmentModalOpen = true;
    render();
  }

  function closeGenericEnvironmentModal() {
    state.genericEnvironmentModalOpen = false;
    render();
  }

  function closePiAuthManageModal() {
    state.piAuthManageModalOpen = false;
    render();
  }

  function openPiModelsModal() {
    state.piModelsModalOpen = true;
    void loadPiModels();
    render();
  }

  function closePiModelsModal() {
    state.piModelsModalOpen = false;
    render();
  }

  return {
    closeAuthModal,
    closePiAuthManageModal,
    closePiModelsModal,
    closeSessionModal,
    closeWorkspaceSubagentModal,
    closeWorkspaceSkillModal,
    closeWorkspaceModal,
    openAuthModal,
    openPiAuthManageModal,
    openPiModelsModal,
    openGenericEnvironmentModal,
    closeGenericEnvironmentModal,
    openSessionModal,
    openWorkspaceSubagentModal,
    openWorkspaceSkillModal,
    openWorkspaceModal,
    showProfile,
  };
}
