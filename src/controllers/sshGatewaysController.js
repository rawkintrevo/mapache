import {createSshGatewaysState} from "../state/initialState.js";
import {friendlyGlobalError} from "../utils/friendlyErrors.js";

export function createSshGatewaysController({state, render = () => {}, api} = {}) {
  if (!state) throw new Error("SSH gateways controller requires app state.");

  let epoch = 0;
  let userId = state.user?.uid || "";

  return {clear, getState: () => state.sshGateways, load, loadWorkspaceStatus, saveAssignments, setIdentity, setWorkspaceGateway};

  function setIdentity(uid = "") {
    const nextUserId = String(uid || "");
    if (nextUserId === userId) return;
    userId = nextUserId;
    clear();
  }

  async function load() {
    const context = {epoch, userId, requestUserId: state.user?.uid || ""};
    state.sshGateways = {...state.sshGateways, loading: true, error: "", message: ""};
    render();
    try {
      const client = api || state.api;
      if (!client?.getSshGateways) throw new Error("SSH gateway management is unavailable.");
      const data = await client.getSshGateways();
      if (!isCurrent(context)) return null;
      state.sshGateways = {
        ...state.sshGateways,
        loading: false,
        attempted: true,
        gateways: Array.isArray(data?.gateways) ? data.gateways : [],
        workspaces: Array.isArray(data?.workspaces) ? data.workspaces : [],
        error: "",
      };
      return state.sshGateways;
    } catch (error) {
      if (isCurrent(context)) {
        state.sshGateways = {
          ...state.sshGateways,
          loading: false,
          attempted: true,
          error: friendlyGlobalError(error),
        };
      }
      return null;
    } finally {
      if (isCurrent(context)) render();
    }
  }

  async function saveAssignments(gatewayId, workspaceIds = []) {
    const context = {epoch, userId, requestUserId: state.user?.uid || ""};
    state.sshGateways = {...state.sshGateways, saving: true, error: "", message: ""};
    render();
    try {
      const client = api || state.api;
      if (!client?.saveSshGatewayAssignments) throw new Error("SSH gateway management is unavailable.");
      const data = await client.saveSshGatewayAssignments(gatewayId, workspaceIds);
      if (!isCurrent(context)) return null;
      const updatedGateway = data?.gateway;
      if (updatedGateway) {
        state.sshGateways.gateways = state.sshGateways.gateways.map((gateway) =>
          gateway.id === updatedGateway.id ? updatedGateway : gateway,
        );
      }
      state.sshGateways.saving = false;
      state.sshGateways.message = "Workspace access saved.";
      render();
      return updatedGateway || null;
    } catch (error) {
      if (isCurrent(context)) {
        state.sshGateways = {
          ...state.sshGateways,
          saving: false,
          error: friendlyGlobalError(error),
        };
        render();
      }
      return null;
    }
  }

  async function loadWorkspaceStatus(workspaceId) {
    const id = String(workspaceId || "");
    if (!id) return null;
    const context = {epoch, userId, requestUserId: state.user?.uid || "", workspaceId: id};
    state.sshGateways.workspace = {
      ...state.sshGateways.workspace,
      workspaceId: id,
      loading: true,
      error: "",
    };
    render();
    try {
      const client = api || state.api;
      if (!client?.getWorkspaceSshGateway) throw new Error("SSH gateway management is unavailable.");
      const data = await client.getWorkspaceSshGateway(id);
      if (!isCurrent(context)) return null;
      state.sshGateways.workspace = {
        ...state.sshGateways.workspace,
        ...data,
        workspaceId: id,
        loading: false,
        attempted: true,
        error: "",
      };
      return state.sshGateways.workspace;
    } catch (error) {
      if (isCurrent(context)) {
        state.sshGateways.workspace = {
          ...state.sshGateways.workspace,
          workspaceId: id,
          loading: false,
          attempted: true,
          error: friendlyGlobalError(error),
        };
      }
      return null;
    } finally {
      if (isCurrent(context)) render();
    }
  }

  async function setWorkspaceGateway(workspaceId, enabled) {
    const id = String(workspaceId || "");
    if (!id) return null;
    const context = {epoch, userId, requestUserId: state.user?.uid || "", workspaceId: id};
    state.sshGateways.workspace = {
      ...state.sshGateways.workspace,
      workspaceId: id,
      saving: true,
      error: "",
    };
    render();
    try {
      const client = api || state.api;
      if (!client?.setWorkspaceSshGateway) throw new Error("SSH gateway management is unavailable.");
      const data = await client.setWorkspaceSshGateway(id, enabled);
      if (!isCurrent(context)) return null;
      state.sshGateways.workspace = {
        ...state.sshGateways.workspace,
        ...data,
        workspaceId: id,
        saving: false,
        attempted: true,
        error: "",
      };
      render();
      return state.sshGateways.workspace;
    } catch (error) {
      if (isCurrent(context)) {
        state.sshGateways.workspace = {
          ...state.sshGateways.workspace,
          workspaceId: id,
          saving: false,
          attempted: true,
          error: friendlyGlobalError(error),
        };
        render();
      }
      return null;
    }
  }

  function isCurrent(context) {
    return context.epoch === epoch && context.userId === userId && context.requestUserId === (state.user?.uid || "") &&
      (!context.workspaceId || context.workspaceId === state.sshGateways.workspace.workspaceId);
  }

  function clear() {
    epoch += 1;
    state.sshGateways = createSshGatewaysState();
    render();
  }
}
