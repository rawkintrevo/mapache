import {APP_ACTIONS} from "../state/appStore.js";

export function createSessionSubscriptionController({
  state,
  dispatch,
  render,
  getFirestoreDb,
  listenToWorkspaceSessions,
  onSelectedSessionChanged,
}) {
  let unsubscribeSessions = null;
  let sessionsListenerWorkspaceId = null;
  let pendingLoadResolve = null;

  function getSelectedSession() {
    return state.sessions.find((session) => session.id === state.selectedSessionId) || null;
  }

  async function loadSessions() {
    detach();
    state.sessions = [];
    dispatch({type: APP_ACTIONS.SET_SELECTED_SESSION, sessionId: null});
    if (!state.selectedWorkspaceId) return;
    await attach(state.selectedWorkspaceId);
  }

  function attach(workspaceId) {
    const db = getFirestoreDb();
    sessionsListenerWorkspaceId = workspaceId;

    return new Promise((resolve) => {
      let resolved = false;
      pendingLoadResolve = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };
      unsubscribeSessions = listenToWorkspaceSessions(
          db,
          workspaceId,
          (sessions) => {
            const selectedSessionChanged = applySessionSnapshot(workspaceId, sessions);
            if (!resolved) {
              resolved = true;
              resolve();
              pendingLoadResolve = null;
            }
            if (selectedSessionChanged) {
              void onSelectedSessionChanged();
            }
            render();
          },
          (error) => {
            if (sessionsListenerWorkspaceId !== workspaceId) return;
            dispatch({
              type: APP_ACTIONS.SET_ERROR,
              error: error.message || "Session listener failed",
            });
            if (!resolved) {
              resolved = true;
              resolve();
              pendingLoadResolve = null;
            }
            render();
          },
      );
    });
  }

  function detach() {
    if (unsubscribeSessions) unsubscribeSessions();
    unsubscribeSessions = null;
    sessionsListenerWorkspaceId = null;
    if (pendingLoadResolve) pendingLoadResolve();
    pendingLoadResolve = null;
  }

  function applySessionSnapshot(workspaceId, sessions) {
    if (sessionsListenerWorkspaceId !== workspaceId || state.selectedWorkspaceId !== workspaceId) {
      return false;
    }

    const previousSession = getSelectedSession();
    const previousSessionId = state.selectedSessionId;
    const previousServiceUrl = previousSession?.serviceUrl || "";
    state.sessions = sessions.filter((session) => String(session.runtimeKind || "").trim().toLowerCase() !== "automation");

    const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
    const canonicalSession = chooseCanonicalSession(state.sessions, workspace?.canonicalSessionId);
    if (state.selectedSessionId !== canonicalSession?.id) {
      dispatch({
        type: APP_ACTIONS.SET_SELECTED_SESSION,
        sessionId: canonicalSession ? canonicalSession.id : null,
      });
    }

    const nextSession = getSelectedSession();
    return previousSessionId !== state.selectedSessionId ||
      previousServiceUrl !== (nextSession?.serviceUrl || "");
  }

  function chooseCanonicalSession(sessions, canonicalSessionId = "") {
    const mainSessions = Array.isArray(sessions) ? sessions.filter((session) =>
      String(session.runtimeKind || "").trim().toLowerCase() !== "automation",
    ) : [];
    if (!mainSessions.length) return null;
    if (canonicalSessionId) {
      const canonical = mainSessions.find((session) => session.id === canonicalSessionId);
      if (canonical) return canonical;
    }
    const active = mainSessions.find((session) => [
      "running", "ready", "provisioning", "queued", "restarting", "resizing", "needs_service", "stopping",
    ].includes(String(session.status || "").toLowerCase()));
    return active || mainSessions[0];
  }

  return {
    applySessionSnapshot,
    attach,
    detach,
    getSelectedSession,
    loadSessions,
    chooseCanonicalSession,
  };
}
