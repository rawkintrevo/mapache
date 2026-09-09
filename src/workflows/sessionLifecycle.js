import {APP_ACTIONS} from "../state/appStore.js";

export async function resizeSessionState(state, sessionId, payload, dispatch) {
  await state.api.resizeSession(state.selectedWorkspaceId, sessionId, payload);
  await refreshSessionsForSelectedWorkspace(state, sessionId, dispatch);
}

export async function editSessionState(state, sessionId, {name, resources}, dispatch) {
  const currentSession = state.sessions.find((session) => session.id === sessionId);
  if (!currentSession) return;

  if (name !== currentSession.name) {
    await state.api.renameSession(state.selectedWorkspaceId, sessionId, name);
  }

  const currentResources = currentSession.resources || {};
  if (resources.cpu !== currentResources.cpu || resources.memory !== currentResources.memory) {
    await state.api.resizeSession(state.selectedWorkspaceId, sessionId, resources);
  }

  await refreshSessionsForSelectedWorkspace(state, sessionId, dispatch);
}

export async function restartSessionState(state, sessionId, dispatch) {
  await state.api.restartSession(state.selectedWorkspaceId, sessionId);
  await refreshSessionsForSelectedWorkspace(state, sessionId, dispatch);
}

export async function retryProvisioningSessionState(state, sessionId) {
  await state.api.restartSession(state.selectedWorkspaceId, sessionId);
}

export async function stopSessionState(state, sessionId, dispatch) {
  await state.api.stopSession(state.selectedWorkspaceId, sessionId);
  await refreshSessionsForSelectedWorkspace(state, sessionId, dispatch);
}

export async function deleteSessionState(state, sessionId, dispatch) {
  await state.api.deleteSession(state.selectedWorkspaceId, sessionId);
  const data = await state.api.getSessions(state.selectedWorkspaceId);
  state.sessions = data.sessions || [];
  if (state.selectedSessionId === sessionId) {
    dispatch({
      type: APP_ACTIONS.SET_SELECTED_SESSION,
      sessionId: state.sessions[0] ? state.sessions[0].id : null,
    });
  }
}

async function refreshSessionsForSelectedWorkspace(state, selectedSessionId, dispatch) {
  const data = await state.api.getSessions(state.selectedWorkspaceId);
  state.sessions = data.sessions || [];
  dispatch({type: APP_ACTIONS.SET_SELECTED_SESSION, sessionId: selectedSessionId});
}
