export async function resizeSessionState(state, sessionId, payload) {
  await state.api.resizeSession(state.selectedWorkspaceId, sessionId, payload);
  await refreshSessionsForSelectedWorkspace(state, sessionId);
}

export async function updateSessionPreviewRootState(state, sessionId, payload) {
  await state.api.updateSessionPreviewRoot(state.selectedWorkspaceId, sessionId, payload);
  await refreshSessionsForSelectedWorkspace(state, sessionId);
}

export async function restartSessionState(state, sessionId) {
  await state.api.restartSession(state.selectedWorkspaceId, sessionId);
  await refreshSessionsForSelectedWorkspace(state, sessionId);
}

export async function stopSessionState(state, sessionId) {
  await state.api.stopSession(state.selectedWorkspaceId, sessionId);
  await refreshSessionsForSelectedWorkspace(state, sessionId);
}

export async function deleteSessionState(state, sessionId) {
  await state.api.deleteSession(state.selectedWorkspaceId, sessionId);
  const data = await state.api.getSessions(state.selectedWorkspaceId);
  state.sessions = data.sessions || [];
  if (state.selectedSessionId === sessionId) {
    state.selectedSessionId = state.sessions[0] ? state.sessions[0].id : null;
  }
}

async function refreshSessionsForSelectedWorkspace(state, selectedSessionId) {
  const data = await state.api.getSessions(state.selectedWorkspaceId);
  state.sessions = data.sessions || [];
  state.selectedSessionId = selectedSessionId;
}
