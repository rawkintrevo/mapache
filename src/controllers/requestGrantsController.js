import {REQUEST_GRANT_PERMISSIONS} from "../state/requestGrantsState.js";

export function createRequestGrantsController({state, render}) {
  function setForm(patch) {
    state.requestGrants = {...state.requestGrants, ...patch};
    render();
  }

  async function load() {
    const workspaceId = state.selectedWorkspaceId;
    if (!workspaceId || !state.api?.getWorkspaceRequestGrants) return;
    state.requestGrants = {...state.requestGrants, loading: true, error: ""};
    render();
    try {
      const grants = await state.api.getWorkspaceRequestGrants(workspaceId);
      state.requestGrants = {...state.requestGrants, grants: Array.isArray(grants) ? grants : [], loading: false};
    } catch (error) {
      state.requestGrants = {...state.requestGrants, loading: false, error: error?.message || "Could not load request grants."};
    }
    render();
  }

  async function save() {
    const {targetWorkspaceId, permissions} = state.requestGrants;
    const sourceWorkspaceId = state.selectedWorkspaceId;
    if (!sourceWorkspaceId || !targetWorkspaceId || !permissions.length) {
      state.requestGrants = {...state.requestGrants, error: "Choose a target and at least one permission."};
      render();
      return;
    }
    state.requestGrants = {...state.requestGrants, saving: true, error: "", message: ""};
    render();
    try {
      await state.api.saveWorkspaceRequestGrant(sourceWorkspaceId, targetWorkspaceId, {permissions, enabled: true});
      state.requestGrants = {...state.requestGrants, saving: false, message: "Grant saved."};
      await load();
    } catch (error) {
      state.requestGrants = {...state.requestGrants, saving: false, error: error?.message || "Could not save request grant."};
      render();
    }
  }

  async function revoke(targetWorkspaceId) {
    const sourceWorkspaceId = state.selectedWorkspaceId;
    if (!sourceWorkspaceId || !targetWorkspaceId) return;
    state.requestGrants = {...state.requestGrants, saving: true, error: "", message: ""};
    render();
    try {
      await state.api.revokeWorkspaceRequestGrant(sourceWorkspaceId, targetWorkspaceId);
      state.requestGrants = {...state.requestGrants, saving: false, message: "Grant revoked."};
      await load();
    } catch (error) {
      state.requestGrants = {...state.requestGrants, saving: false, error: error?.message || "Could not revoke request grant."};
      render();
    }
  }

  function togglePermission(permission) {
    const permissions = state.requestGrants.permissions.includes(permission) ?
      state.requestGrants.permissions.filter((item) => item !== permission) :
      [...state.requestGrants.permissions, permission];
    setForm({permissions});
  }

  return {load, revoke, save, setForm, togglePermission, permissions: REQUEST_GRANT_PERMISSIONS};
}
