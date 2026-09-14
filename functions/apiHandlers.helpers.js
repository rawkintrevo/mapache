"use strict";

function createApiHandlers({agentAuthService, environmentKeysService, openAiCodexAuthService, qaFaultHarnessService, workspaceService, githubService, googleWorkspaceService = {}, operations}) {
  return Object.freeze({
    ...operations,
    getPiAuth: agentAuthService.getPiAuth,
    savePiAuthProvider: agentAuthService.savePiAuthProvider,
    deletePiAuthProvider: agentAuthService.deletePiAuthProvider,
    deletePiAuthEntry: agentAuthService.deletePiAuthEntry,
    listGenericEnvironmentKeys: environmentKeysService.listGenericEnvironmentKeys,
    createGenericEnvironmentKey: environmentKeysService.createGenericEnvironmentKey,
    updateGenericEnvironmentKey: environmentKeysService.updateGenericEnvironmentKey,
    deleteGenericEnvironmentKey: environmentKeysService.deleteGenericEnvironmentKey,
    startOpenAiCodexDeviceCode: openAiCodexAuthService.startOpenAiCodexDeviceCode,
    completeOpenAiCodexDeviceCode: openAiCodexAuthService.completeOpenAiCodexDeviceCode,
    saveSessionPiAuthSelection: agentAuthService.saveSessionPiAuthSelection,
    getSessionQaFaults: qaFaultHarnessService?.getStatus || (async () => { throw new Error("QA fault harness service is unavailable"); }),
    armSessionQaFault: qaFaultHarnessService?.arm || (async () => { throw new Error("QA fault harness service is unavailable"); }),
    listWorkspaces: workspaceService.listWorkspaces,
    createWorkspace: workspaceService.createWorkspace,
    renameWorkspace: workspaceService.renameWorkspace,
    deleteWorkspace: workspaceService.deleteWorkspace,
    getWorkspaceMcpConfig: workspaceService.getWorkspaceMcpConfig,
    saveWorkspaceMcpConfig: workspaceService.saveWorkspaceMcpConfig,
    listConnectedRepos: githubService.listConnectedRepos,
    createGithubConnectUrl: githubService.createGithubConnectUrl,
    getGithubConnection: githubService.getGithubConnection,
    disconnectGithub: githubService.disconnectGithub,
    listGoogleWorkspaceServices: googleWorkspaceService.listGoogleWorkspaceServices,
    listGoogleConnections: googleWorkspaceService.listGoogleConnections,
    getGoogleConnection: googleWorkspaceService.getGoogleConnection,
    deleteGoogleConnection: googleWorkspaceService.deleteGoogleConnection,
    startGoogleConnection: googleWorkspaceService.startGoogleConnection,
    getWorkspaceGoogleConnection: googleWorkspaceService.getWorkspaceGoogleConnection,
    bindWorkspaceGoogleConnection: googleWorkspaceService.bindWorkspaceGoogleConnection,
    unbindWorkspaceGoogleConnection: googleWorkspaceService.unbindWorkspaceGoogleConnection,
  });
}

module.exports = {createApiHandlers};
