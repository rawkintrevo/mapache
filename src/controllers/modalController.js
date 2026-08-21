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

  function openGoogleWorkspaceModal(connection = null) {
    const enabledServices = Array.isArray(connection?.enabledServices) ? connection.enabledServices : [];
    state.googleWorkspace = {
      ...state.googleWorkspace,
      accessLevel: "read",
      editingConnectionId: connection?.connectionId || "",
      error: "",
      message: "",
      selectedServices: enabledServices,
    };
    state.googleWorkspaceModalOpen = true;
    render();
  }

  function closeGoogleWorkspaceModal() {
    state.googleWorkspaceModalOpen = false;
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

  function openAuthModal(providerOrEntry = "") {
    const entry = providerOrEntry?.providerKey ? providerOrEntry : null;
    const selectedProvider = entry?.providerKey || (typeof providerOrEntry === "string" ? providerOrEntry.trim() : "");
    state.authReturnToManage = Boolean(state.piAuthManageModalOpen);
    state.piAuthManageModalOpen = false;
    state.piAuth = {
      ...state.piAuth,
      selectedProvider: selectedProvider || state.piAuth.selectedProvider,
      editEntryId: entry?.id || "",
      entryLabel: entry?.label || "",
      apiKey: "",
      openAiCodexDevice: null,
      error: "",
      message: "",
    };
    state.authModalOpen = true;
    render();
  }

  function closeAuthModal() {
    state.authModalOpen = false;
    if (state.authReturnToManage) state.piAuthManageModalOpen = true;
    state.authReturnToManage = false;
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
    closeGoogleWorkspaceModal,
    closePiAuthManageModal,
    closePiModelsModal,
    closeSessionModal,
    closeWorkspaceSubagentModal,
    closeWorkspaceSkillModal,
    closeWorkspaceModal,
    openAuthModal,
    openGoogleWorkspaceModal,
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
