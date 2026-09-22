/**
 * Workspace automation API facade.
 *
 * Keeping this surface separate from the general API client gives the
 * controller one place to describe automation operations and keeps request
 * identity (workspace, definition, run, and idempotency key) explicit.
 */
export function createAutomationsApi(apiOrOptions) {
  const api = apiOrOptions?.api || apiOrOptions;
  if (!api) throw new Error("Automation API requires an API client.");

  return {
    listWorkspaces: () => api.getWorkspaces(),
    listDefinitions: (workspaceId) => api.getAutomations(workspaceId),
    createDefinition: (workspaceId, body) => api.createAutomation(workspaceId, body),
    getDefinition: (workspaceId, automationId) => api.getAutomation(workspaceId, automationId),
    updateDefinition: (workspaceId, automationId, body) => api.updateAutomation(workspaceId, automationId, body),
    deleteDefinition: (workspaceId, automationId, body) => api.deleteAutomation(workspaceId, automationId, body),
    getSettings: (workspaceId) => api.getAutomationSettings(workspaceId),
    updateSettings: (workspaceId, body) => api.updateAutomationSettings(workspaceId, body),
    prepareStorage: (workspaceId) => api.prepareAutomationStorage(workspaceId),
    previewSchedule: (cron, timezone) => api.previewAutomationSchedule(cron, timezone),
    runNow: (workspaceId, automationId, body, idempotencyKey) => api.enqueueAutomationRun(
        workspaceId,
        automationId,
        {...body, trigger: body?.trigger || "manual"},
        idempotencyKey,
    ),
    listHistory: (query) => api.listAutomationRuns(query),
    getRun: (runId) => api.getAutomationRun(runId),
    listEvents: (runId, query) => api.listAutomationRunEvents(runId, query),
    stopRun: (runId) => api.stopAutomationRun(runId),
    cancelRun: (runId) => api.cancelAutomationRun(runId),
    restartRun: (runId, idempotencyKey) => api.restartAutomationRun(runId, idempotencyKey),
  };
}
