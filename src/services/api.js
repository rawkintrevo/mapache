import {createGoogleWorkspaceQaMock} from "./googleWorkspaceQaMock.js";

function encodePathQuery(value) {
  return encodeURIComponent(encodeURIComponent(String(value || "")));
}

export function createApiClient(getToken) {
  const api = {
    getMe: () => request(getToken, "/api/me"),
    getAdminUsers: ({cursor = "", pageSize = 25} = {}) => {
      const params = new URLSearchParams();
      params.set("pageSize", String(pageSize));
      if (cursor) params.set("cursor", cursor);
      return request(getToken, `/api/admin/users?${params.toString()}`);
    },
    setAdminUserWhitelisted: (uid, whitelisted) => request(
        getToken,
        `/api/admin/users/${encodeURIComponent(uid)}/whitelist`,
        {method: "POST", body: {whitelisted}},
    ),
    getPiAuth: () => request(getToken, "/api/auth"),
    savePiAuthProvider: (provider, key, label = "", entryId = "") => request(
        getToken,
        `/api/auth/providers/${encodeURIComponent(provider)}`,
        {method: "PUT", body: {key, label, entryId}},
    ),
    deletePiAuthProvider: (provider) => request(
        getToken,
        `/api/auth/providers/${encodeURIComponent(provider)}`,
        {method: "DELETE"},
    ),
    deletePiAuthEntry: (entryId) => request(
        getToken,
        `/api/auth/entries/${encodeURIComponent(entryId)}`,
        {method: "DELETE"},
    ),
    getGenericEnvironmentKeys: () => request(getToken, "/api/auth/environment"),
    createGenericEnvironmentKey: (body) => request(getToken, "/api/auth/environment", {method: "POST", body}),
    updateGenericEnvironmentKey: (entryId, body) => request(getToken, `/api/auth/environment/${encodeURIComponent(entryId)}`, {method: "PUT", body}),
    deleteGenericEnvironmentKey: (entryId) => request(getToken, `/api/auth/environment/${encodeURIComponent(entryId)}`, {method: "DELETE"}),
    startOpenAiCodexDeviceLogin: () => request(
        getToken,
        "/api/auth/providers/openai-codex/device-code/start",
        {method: "POST", body: {}},
    ),
    completeOpenAiCodexDeviceLogin: (deviceAuthId, userCode, entryId = "", label = "") => request(
        getToken,
        "/api/auth/providers/openai-codex/device-code/complete",
        {method: "POST", body: {deviceAuthId, userCode, entryId, label}},
    ),
    getWorkspaces: () => request(getToken, "/api/workspaces"),
    createWorkspace: (body) => request(getToken, "/api/workspaces", {
      method: "POST",
      body,
    }),
    renameWorkspace: (workspaceId, body) => request(
        getToken,
        `/api/workspaces/${workspaceId}`,
        {method: "PATCH", body: typeof body === "string" ? {name: body} : body},
    ),
    deleteWorkspace: (workspaceId) => request(
        getToken,
        `/api/workspaces/${workspaceId}`,
        {method: "DELETE"},
    ),
    getWorkspaceMcpConfig: (workspaceId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/mcp`,
    ),
    saveWorkspaceMcpConfig: (workspaceId, body) => request(
        getToken,
        `/api/workspaces/${workspaceId}/mcp`,
        {method: "PUT", body},
    ),
    getGoogleWorkspaceServices: () => request(getToken, "/api/google/services"),
    getGoogleConnections: () => request(getToken, "/api/google/connections"),
    getGoogleConnection: (connectionId) => request(
        getToken,
        `/api/google/connections/${encodeURIComponent(connectionId)}`,
    ),
    deleteGoogleConnection: (connectionId) => request(
        getToken,
        `/api/google/connections/${encodeURIComponent(connectionId)}`,
        {method: "DELETE"},
    ),
    getWorkspaceGoogleConnection: (workspaceId) => request(
        getToken,
        `/api/workspaces/${encodeURIComponent(workspaceId)}/google`,
    ),
    startGoogleConnection: (workspaceId, body) => request(
        getToken,
        `/api/workspaces/${encodeURIComponent(workspaceId)}/google/connect`,
        {method: "POST", body},
    ),
    bindGoogleConnection: (workspaceId, body) => request(
        getToken,
        `/api/workspaces/${encodeURIComponent(workspaceId)}/google/binding`,
        {method: "POST", body},
    ),
    unbindGoogleConnection: (workspaceId) => request(
        getToken,
        `/api/workspaces/${encodeURIComponent(workspaceId)}/google/binding`,
        {method: "DELETE"},
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
    renameSession: (workspaceId, sessionId, name) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}`,
        {method: "PATCH", body: {name}},
    ),
    setSessionLongRunning: (workspaceId, sessionId, enabled) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/long-running`,
        {method: "PATCH", body: {enabled}},
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
    deleteSession: (workspaceId, sessionId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}`,
        {method: "DELETE"},
    ),
    getSessionAccessUrls: (workspaceId, sessionId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/access-url`,
        {method: "POST", body: {}},
    ),
    getSessionLogs: (workspaceId, sessionId, limit = 200) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/logs?limit=${encodeURIComponent(limit)}`,
    ),
    getSessionQaFaults: (workspaceId, sessionId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/qa/faults`,
    ),
    armSessionQaFault: (workspaceId, sessionId, body) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/qa/faults`,
        {method: "POST", body},
    ),
    shareSessionPreview: (workspaceId, sessionId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/share-preview`,
        {method: "POST", body: {}},
    ),
    saveSessionPiAuthSelection: (workspaceId, sessionId, selection) => {
      const body = {selection: selection.providers || selection};
      if (Array.isArray(selection.environmentEntryIds)) body.environmentEntryIds = selection.environmentEntryIds;
      return request(
          getToken,
          `/api/workspaces/${workspaceId}/sessions/${sessionId}/auth-selection`,
          {method: "POST", body},
      );
    },
    getGithubConnection: () => request(getToken, "/api/github/connection"),
    disconnectGithub: () => request(
        getToken,
        "/api/github/disconnect",
        {method: "POST", body: {}},
    ),
    getConnectedRepos: () => request(getToken, "/api/github/repos"),
    getGithubConnectUrl: () => request(
        getToken,
        `/api/github/connect?returnTo=${encodeURIComponent(window.location.href)}`,
    ),
  };
  return {...api, ...createGoogleWorkspaceQaMock()};
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
