export function createApiClient(getToken) {
  return {
    getMe: () => request(getToken, "/api/me"),
    getWorkspaces: () => request(getToken, "/api/workspaces"),
    createWorkspace: (body) => request(getToken, "/api/workspaces", {
      method: "POST",
      body,
    }),
    getWorkspaceFiles: (workspaceId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/files`,
    ),
    getWorkspaceFile: (workspaceId, path) => request(
        getToken,
        `/api/workspaces/${workspaceId}/file?path=${encodeURIComponent(path)}`,
    ),
    saveWorkspaceFile: (workspaceId, path, content) => request(
        getToken,
        `/api/workspaces/${workspaceId}/file?path=${encodeURIComponent(path)}`,
        {method: "PUT", body: {content}},
    ),
    getSessions: (workspaceId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions`,
    ),
    createSession: (workspaceId, body) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions`,
        {method: "POST", body},
    ),
    resizeSession: (workspaceId, sessionId, body) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/resize`,
        {method: "POST", body},
    ),
    restartSession: (workspaceId, sessionId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/restart`,
        {method: "POST", body: {}},
    ),
    stopSession: (workspaceId, sessionId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/stop`,
        {method: "POST", body: {}},
    ),
    getGitStatus: (workspaceId, sessionId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/git-status`,
    ),
    pullGit: (workspaceId, sessionId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/git-pull`,
        {method: "POST", body: {}},
    ),
  };
}

async function request(getToken, path, options = {}) {
  const token = await getToken();
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || response.statusText || "Request failed");
  }
  return data;
}
