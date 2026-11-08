import {createSshGatewaysState} from "../state/initialState.js";
import {friendlyGlobalError} from "../utils/friendlyErrors.js";

export function createSshGatewaysController({state, render = () => {}, api} = {}) {
  if (!state) throw new Error("SSH gateways controller requires app state.");

  let epoch = 0;
  let userId = state.user?.uid || "";

  return {clear, getState: () => state.sshGateways, load, saveAssignments, setIdentity};

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

  function isCurrent(context) {
    return context.epoch === epoch && context.userId === userId && context.requestUserId === (state.user?.uid || "");
  }

  function clear() {
    epoch += 1;
    state.sshGateways = createSshGatewaysState();
    render();
  }
}
