export function createSessionRequestTracker(state) {
  let generation = 0;

  return {
    capture() {
      const requestGeneration = ++generation;
      const workspaceId = state.selectedWorkspaceId;
      const sessionId = state.selectedSessionId;
      return {
        workspaceId,
        sessionId,
        isCurrent() {
          return requestGeneration === generation &&
            state.selectedWorkspaceId === workspaceId &&
            state.selectedSessionId === sessionId;
        },
      };
    },
  };
}

export function isCurrentSessionRequest(request) {
  return !request || typeof request.isCurrent !== "function" || request.isCurrent();
}
