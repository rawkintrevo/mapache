import {createGoogleWorkspaceQaMock} from "./googleWorkspaceQaMock.js";

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
    renameWorkspace: (workspaceId, name) => request(
        getToken,
        `/api/workspaces/${workspaceId}`,
        {method: "PATCH", body: {name}},
    ),
    deleteWorkspace: (workspaceId) => request(
        getToken,
        `/api/workspaces/${workspaceId}`,
        {method: "DELETE"},
    ),
    getWorkspaceFiles: (workspaceId, path = "") => request(
        getToken,
        `/api/workspaces/${workspaceId}/files${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),
    syncWorkspaceFiles: (workspaceId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sync-files`,
        {method: "POST", body: {}},
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
    getSshSessionFiles: (workspaceId, sessionId, path = "") => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/ssh-files${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),
    getSshSessionFile: (workspaceId, sessionId, path) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/ssh-file?path=${encodeURIComponent(path)}`,
    ),
    saveSshSessionFile: (workspaceId, sessionId, path, content) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/ssh-file?path=${encodeURIComponent(path)}`,
        {method: "PUT", body: {content}},
    ),
    getWorkspaceFileDownloadUrl: (workspaceId, path) => request(
        getToken,
        `/api/workspaces/${workspaceId}/file/download-url?path=${encodeURIComponent(path)}`,
        {method: "POST", body: {}},
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
    uploadWorkspaceFile: (workspaceId, file) => uploadFile(
        getToken,
        `/api/workspaces/${workspaceId}/file?path=${encodeURIComponent(file.name)}`,
        file,
    ),
    createWorkspaceFile: (workspaceId, path) => request(
        getToken,
        `/api/workspaces/${workspaceId}/create-file`,
        {method: "POST", body: {path}},
    ),
    createWorkspaceDirectory: (workspaceId, path) => request(
        getToken,
        `/api/workspaces/${workspaceId}/create-directory`,
        {method: "POST", body: {path}},
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
    shareSessionPreview: (workspaceId, sessionId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/share-preview`,
        {method: "POST", body: {}},
    ),
    getSshSessionForwards: (workspaceId, sessionId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/ssh-ports`,
    ),
    createSshSessionForward: (workspaceId, sessionId, port) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/ssh-ports`,
        {method: "POST", body: {port}},
    ),
    closeSshSessionForward: (workspaceId, sessionId, port) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/ssh-ports/${encodeURIComponent(port)}`,
        {method: "DELETE"},
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
    getGitStatus: (workspaceId, sessionId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/git-status`,
    ),
    pullGit: (workspaceId, sessionId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/git-pull`,
        {method: "POST", body: {}},
    ),
    stageGit: (workspaceId, sessionId, paths) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/git-stage`,
        {method: "POST", body: {paths}},
    ),
    unstageGit: (workspaceId, sessionId, paths) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/git-unstage`,
        {method: "POST", body: {paths}},
    ),
    commitGit: (workspaceId, sessionId, message) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/git-commit`,
        {method: "POST", body: {message}},
    ),
    pushGit: (workspaceId, sessionId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/git-push`,
        {method: "POST", body: {}},
    ),
    openPullRequest: (workspaceId, sessionId, body) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/git-open-pr`,
        {method: "POST", body},
    ),
    getPiPackages: (workspaceId, sessionId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/pi-packages`,
    ),
    getPiModels: (workspaceId, sessionId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/models`,
    ),
    getPiModelsFile: (workspaceId, sessionId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/models-file`,
    ),
    savePiModelsFile: (workspaceId, sessionId, content) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/models-file`,
        {method: "PUT", body: {content}},
    ),
    savePiModelScope: (workspaceId, sessionId, scopedModels) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/models`,
        {method: "PUT", body: {scopedModels}},
    ),
    installPiPackage: (workspaceId, sessionId, source) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/pi-packages/install`,
        {method: "POST", body: {source}},
    ),
    removePiPackage: (workspaceId, sessionId, source) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/pi-packages/remove`,
        {method: "POST", body: {source}},
    ),
    updatePiPackage: (workspaceId, sessionId, source = "") => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/pi-packages/update`,
        {method: "POST", body: source ? {source} : {}},
    ),
    getWorkspaceSkills: (workspaceId, sessionId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/skills`,
    ),
    saveWorkspaceSkill: (workspaceId, sessionId, body) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/skills`,
        {method: "POST", body},
    ),
    deleteWorkspaceSkill: (workspaceId, sessionId, name) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/skills/delete`,
        {method: "POST", body: {name}},
    ),
    getWorkspaceSubagents: (workspaceId, sessionId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/subagents`,
    ),
    saveWorkspaceSubagent: (workspaceId, sessionId, body) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/subagents`,
        {method: "POST", body},
    ),
    deleteWorkspaceSubagent: (workspaceId, sessionId, name) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/subagents/delete`,
        {method: "POST", body: {name}},
    ),
    getPiSkills: (workspaceId, sessionId) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/pi-skills`,
    ),
    savePiSkill: (workspaceId, sessionId, body) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/pi-skills`,
        {method: "POST", body},
    ),
    deletePiSkill: (workspaceId, sessionId, name) => request(
        getToken,
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/pi-skills/delete`,
        {method: "POST", body: {name}},
    ),
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

async function uploadFile(getToken, path, file) {
  const token = await getToken();
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || response.statusText || "Request failed");
  }
  return data;
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
