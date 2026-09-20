import {createAutomationsState} from "../state/initialState.js";
import {createAutomationsApi} from "../services/automationsApi.js";

const POLL_INTERVAL_MS = 5_000;
const ACTIVE_RUN_STATUSES = new Set(["queued", "provisioning", "running", "stopping"]);

/**
 * Owns automation workflow state without coupling it to a rendered surface.
 * Firestore remains the source of session state; automation definitions and
 * history are deliberately fetched through the bounded HTTP API.
 */
export function createAutomationsController({
  state,
  render = () => {},
  api,
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
  documentImpl = typeof document === "undefined" ? null : document,
} = {}) {
  if (!state) throw new Error("Automation controller requires app state.");
  if (!state.automations) state.automations = createAutomationsState();

  let contextEpoch = 0;
  let contextUserId = state.user?.uid || "";
  let pollTimer = null;
  let visibilityAttached = false;
  let actionKeys = new Map();
  let actionSequence = 0;

  return {
    cancelRun,
    clear,
    createDefinition,
    deleteDefinition,
    dispose,
    getSettings,
    getState: () => state.automations,
    loadDefinitions,
    listDefinitions: loadDefinitions,
    listEvents: loadEvents,
    listHistory: loadHistory,
    loadDefinition,
    loadNextHistoryPage,
    loadRun,
    loadWorkspace,
    prepareStorage,
    previewSchedule,
    refresh: loadWorkspace,
    restartRun,
    runNow,
    selectRun,
    selectDefinition,
    setHistoryFilters,
    setIdentity,
    setWorkspace,
    stopRun,
    updateDefinition,
    updateSettings,
  };

  function getAutomationApi() {
    const client = api || state.api;
    if (!client) throw new Error("Authentication is required for automation requests.");
    return client.listDefinitions ? client : createAutomationsApi(client);
  }

  function setIdentity(uid = "") {
    const nextUserId = String(uid || "");
    if (nextUserId === contextUserId) return;
    contextUserId = nextUserId;
    contextEpoch += 1;
    actionKeys = new Map();
    resetSlice(state.selectedWorkspaceId);
    render();
  }

  function setWorkspace(workspaceId = state.selectedWorkspaceId) {
    const nextWorkspaceId = workspaceId || null;
    if (state.automations.selectedWorkspaceId === nextWorkspaceId && contextUserId === (state.user?.uid || "")) {
      ensurePolling();
      return;
    }
    contextEpoch += 1;
    contextUserId = state.user?.uid || contextUserId;
    actionKeys = new Map();
    resetSlice(nextWorkspaceId);
    if (nextWorkspaceId) ensurePolling();
    render();
  }

  async function loadWorkspace(workspaceId = state.selectedWorkspaceId) {
    setWorkspace(workspaceId);
    const context = capture(workspaceId);
    if (!context.workspaceId) return null;
    const client = getAutomationApi();
    setBusy(true, "load");
    try {
      const [definitions, settings] = await Promise.all([
        client.listDefinitions(context.workspaceId),
        client.getSettings(context.workspaceId),
      ]);
      if (!isCurrent(context)) return null;
      applyDefinitions(definitions?.automations || []);
      state.automations.maxConcurrency = Number(settings?.automationMaxConcurrency) || 1;
      updateStorageState(context.workspaceId);
      state.automations.error = "";
      return state.automations;
    } catch (error) {
      if (isCurrent(context)) handleError(error);
      return null;
    } finally {
      if (isCurrent(context)) setBusy(false, "load");
    }
  }

  async function loadDefinitions(workspaceId = state.selectedWorkspaceId) {
    setWorkspace(workspaceId);
    const context = capture(workspaceId);
    if (!context.workspaceId) return null;
    return perform(context, "definitions", async (client) => {
      const data = await client.listDefinitions(context.workspaceId);
      if (!isCurrent(context)) return null;
      applyDefinitions(data?.automations || []);
      updateStorageState(context.workspaceId);
      return state.automations.definitions;
    });
  }

  async function loadDefinition(automationId, workspaceId = state.selectedWorkspaceId) {
    setWorkspace(workspaceId);
    const context = capture(workspaceId);
    if (!context.workspaceId || !automationId) return null;
    return perform(context, "definition", async (client) => {
      const data = await client.getDefinition(context.workspaceId, automationId);
      if (!isCurrent(context)) return null;
      if (data?.automation) applyDefinition(data.automation);
      return data?.automation || null;
    });
  }

  async function createDefinition(body, workspaceId = state.selectedWorkspaceId) {
    setWorkspace(workspaceId);
    const context = capture(workspaceId);
    if (!context.workspaceId) return null;
    return perform(context, "create", async (client) => {
      const data = await client.createDefinition(context.workspaceId, body || {});
      if (!isCurrent(context)) return null;
      if (data?.automation) applyDefinition(data.automation, {select: true});
      return data?.automation || null;
    });
  }

  async function updateDefinition(automationId, body = {}, workspaceId = state.selectedWorkspaceId) {
    setWorkspace(workspaceId);
    const context = capture(workspaceId);
    if (!context.workspaceId || !automationId) return null;
    const definition = findDefinition(automationId);
    const payload = {
      ...body,
      ...(body.expectedRevision === undefined && definition?.revision !== undefined ?
        {expectedRevision: definition.revision} : {}),
    };
    return perform(context, "update", async (client) => {
      const data = await client.updateDefinition(context.workspaceId, automationId, payload);
      if (!isCurrent(context)) return null;
      if (data?.automation) applyDefinition(data.automation, {select: true});
      return data?.automation || null;
    }, {automationId});
  }

  async function deleteDefinition(automationId, body = {}, workspaceId = state.selectedWorkspaceId) {
    setWorkspace(workspaceId);
    const context = capture(workspaceId);
    if (!context.workspaceId || !automationId) return null;
    const definition = findDefinition(automationId);
    const payload = {
      ...body,
      ...(body.expectedRevision === undefined && definition?.revision !== undefined ?
        {expectedRevision: definition.revision} : {}),
    };
    return perform(context, "delete", async (client) => {
      const data = await client.deleteDefinition(context.workspaceId, automationId, payload);
      if (!isCurrent(context)) return null;
      state.automations.definitions = state.automations.definitions.filter((item) => item.id !== automationId);
      if (state.automations.selectedAutomationId === automationId) selectDefinition("");
      return data;
    }, {automationId});
  }

  async function getSettings(workspaceId = state.selectedWorkspaceId) {
    setWorkspace(workspaceId);
    const context = capture(workspaceId);
    if (!context.workspaceId) return null;
    return perform(context, "settings", async (client) => {
      const settings = await client.getSettings(context.workspaceId);
      if (!isCurrent(context)) return null;
      state.automations.maxConcurrency = Number(settings?.automationMaxConcurrency) || 1;
      updateStorageState(context.workspaceId);
      return settings;
    });
  }

  async function updateSettings(body, workspaceId = state.selectedWorkspaceId) {
    setWorkspace(workspaceId);
    const context = capture(workspaceId);
    if (!context.workspaceId) return null;
    return perform(context, "settings", async (client) => {
      const settings = await client.updateSettings(context.workspaceId, body || {});
      if (!isCurrent(context)) return null;
      state.automations.maxConcurrency = Number(settings?.automationMaxConcurrency) || 1;
      return settings;
    });
  }

  async function prepareStorage(workspaceId = state.selectedWorkspaceId) {
    setWorkspace(workspaceId);
    const context = capture(workspaceId);
    if (!context.workspaceId) return null;
    return perform(context, "storage", async (client) => {
      const result = await client.prepareStorage(context.workspaceId);
      if (!isCurrent(context)) return null;
      state.automations.storageState = "preparing";
      state.automations.storageReady = false;
      return result;
    });
  }

  async function previewSchedule(cron, timezone) {
    try {
      return await getAutomationApi().previewSchedule(cron, timezone);
    } catch (error) {
      handleError(error);
      return null;
    }
  }

  async function loadHistory(options = {}) {
    const workspaceId = options.workspaceId || state.selectedWorkspaceId;
    setWorkspace(workspaceId);
    const context = capture(workspaceId);
    if (!context.workspaceId) return null;
    const filters = {...state.automations.history.filters, ...(options.filters || {})};
    const requestedCursor = options.cursor === undefined ? (options.append ? state.automations.history.nextCursor : "") : options.cursor;
    const query = {...filters, ...(requestedCursor ? {cursor: requestedCursor} : {})};
    state.automations.history.loading = true;
    state.automations.history.error = "";
    if (!options.silent) {
      render();
    }
    try {
      const data = await getAutomationApi().listHistory(query);
      if (!isCurrent(context)) return null;
      state.automations.history.filters = filters;
      state.automations.history.cursor = requestedCursor || "";
      state.automations.history.nextCursor = data?.nextCursor || "";
      state.automations.history.runs = options.append ?
        [...state.automations.history.runs, ...(data?.runs || [])] : (data?.runs || []);
      state.automations.history.error = "";
      updatePollingState();
      return data;
    } catch (error) {
      if (isCurrent(context)) {
        state.automations.history.error = error.message || "Could not load automation history.";
        handleError(error);
      }
      return null;
    } finally {
      if (isCurrent(context)) {
        state.automations.history.loading = false;
        render();
      }
    }
  }

  async function loadNextHistoryPage() {
    if (!state.automations.history.nextCursor) return null;
    return loadHistory({append: true});
  }

  async function setHistoryFilters(filters = {}) {
    state.automations.history.filters = {...filters};
    state.automations.history.cursor = "";
    state.automations.history.nextCursor = "";
    return loadHistory({filters, cursor: ""});
  }

  async function selectRun(runId) {
    state.automations.selectedRunId = runId || "";
    state.automations.selectedRun = null;
    state.automations.events = [];
    state.automations.eventsNextCursor = "";
    render();
    return runId ? loadRun(runId) : null;
  }

  async function loadRun(runId, workspaceId = state.selectedWorkspaceId) {
    setWorkspace(workspaceId);
    const context = capture(workspaceId);
    if (!context.workspaceId || !runId) return null;
    const runContext = {...context, runId};
    try {
      const [runData, eventData] = await Promise.all([
        getAutomationApi().getRun(runId),
        getAutomationApi().listEvents(runId),
      ]);
      if (!isCurrent(runContext) || state.automations.selectedRunId !== runId) return null;
      state.automations.selectedRun = runData?.run || null;
      state.automations.events = eventData?.events || [];
      state.automations.eventsNextCursor = eventData?.nextCursor || "";
      updatePollingState();
      render();
      return state.automations.selectedRun;
    } catch (error) {
      if (isCurrent(runContext)) handleError(error);
      return null;
    }
  }

  async function loadEvents(runId = state.automations.selectedRunId, options = {}) {
    const context = capture(state.selectedWorkspaceId);
    if (!context.workspaceId || !runId) return null;
    const cursor = options.cursor === undefined ? "" : options.cursor;
    try {
      const data = await getAutomationApi().listEvents(runId, cursor ? {cursor} : {});
      if (!isCurrent({...context, runId}) || state.automations.selectedRunId !== runId) return null;
      state.automations.events = options.append ?
        [...state.automations.events, ...(data?.events || [])] : (data?.events || []);
      state.automations.eventsNextCursor = data?.nextCursor || "";
      render();
      return data;
    } catch (error) {
      if (isCurrent(context)) handleError(error);
      return null;
    }
  }

  async function runNow(automationId, body = {}, workspaceId = state.selectedWorkspaceId) {
    return runAction("run", automationId, workspaceId, (client, context, key) => client.runNow(
        context.workspaceId, automationId, body, key,
    ));
  }

  async function stopRun(runId, workspaceId = state.selectedWorkspaceId) {
    return runAction("stop", runId, workspaceId, (client, _context) => client.stopRun(runId));
  }

  async function cancelRun(runId, workspaceId = state.selectedWorkspaceId) {
    return runAction("cancel", runId, workspaceId, (client, _context) => client.cancelRun(runId));
  }

  async function restartRun(runId, workspaceId = state.selectedWorkspaceId) {
    return runAction("restart", runId, workspaceId, (client, _context, key) => client.restartRun(runId, key));
  }

  async function runAction(action, resourceId, workspaceId, task) {
    setWorkspace(workspaceId);
    const context = capture(workspaceId);
    if (!context.workspaceId || !resourceId) return null;
    const keyName = `${contextUserId}:${context.workspaceId}:${action}:${resourceId}`;
    const key = action === "run" || action === "restart" ? getActionKey(keyName) : "";
    const result = await perform(context, action, (client) => task(client, context, key), {
      runId: action === "run" ? "" : resourceId,
    });
    if (result && key) actionKeys.delete(keyName);
    if (result && isCurrent(context)) {
      state.automations.pendingRunId = "";
      state.automations.requiresMainPausedRunId = "";
      if (action === "run" && result.run?.id) state.automations.selectedRunId = result.run.id;
      await loadHistory({silent: true});
    }
    return result;
  }

  function getActionKey(name) {
    if (!actionKeys.has(name)) {
      actionSequence += 1;
      const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${actionSequence}`;
      actionKeys.set(name, `mapache-automation-${random}`);
    }
    return actionKeys.get(name);
  }

  async function perform(context, action, task, metadata = {}) {
    setBusy(true, action);
    try {
      const result = await task(getAutomationApi());
      if (!isCurrent(context)) return null;
      state.automations.error = "";
      state.automations.conflict = null;
      if (metadata.runId) {
        state.automations.selectedRunId = metadata.runId;
        updatePollingState();
      }
      return result;
    } catch (error) {
      if (isCurrent(context)) await handleError(error, metadata);
      return null;
    } finally {
      if (isCurrent(context)) setBusy(false, action);
    }
  }

  async function handleError(error, metadata = {}) {
    const code = error?.code || error?.message || "Request failed";
    state.automations.error = code;
    if (code === "revision_conflict" || error?.status === 409 && metadata.automationId) {
      const conflict = {type: "revision", automationId: metadata.automationId};
      state.automations.conflict = conflict;
      if (metadata.automationId) await loadDefinition(metadata.automationId);
      state.automations.conflict = conflict;
      state.automations.error = code;
    } else if (code === "pending_run_exists") {
      state.automations.pendingRunId = error?.data?.pendingRunId || error?.pendingRunId || "";
    } else if (code === "automation_requires_main_paused") {
      state.automations.requiresMainPausedRunId = error?.data?.runId || error?.runId || "";
    }
    render();
  }

  function applyDefinitions(definitions) {
    state.automations.definitions = definitions;
    const selected = findDefinition(state.automations.selectedAutomationId) || definitions[0] || null;
    selectDefinition(selected?.id || "", false);
  }

  function applyDefinition(definition, {select = false} = {}) {
    const index = state.automations.definitions.findIndex((item) => item.id === definition.id);
    if (index < 0) state.automations.definitions = [...state.automations.definitions, definition];
    else state.automations.definitions = state.automations.definitions.map((item, itemIndex) => itemIndex === index ? definition : item);
    if (select || state.automations.selectedAutomationId === definition.id) selectDefinition(definition.id, false);
  }

  function selectDefinition(automationId, shouldRender = true) {
    state.automations.selectedAutomationId = automationId || "";
    const definition = findDefinition(automationId);
    state.automations.editRevision = definition?.revision ?? null;
    if (shouldRender) render();
  }

  function findDefinition(automationId) {
    return state.automations.definitions.find((item) => item.id === automationId) || null;
  }

  function updateStorageState(workspaceId) {
    const workspace = state.workspaces?.find((item) => item.id === workspaceId);
    const storageState = String(workspace?.sharedStorageState || workspace?.sharedStorage?.state || "").toLowerCase();
    state.automations.storageState = storageState;
    state.automations.storageReady = storageState === "ready";
  }

  function capture(workspaceId) {
    return {
      epoch: contextEpoch,
      userId: contextUserId || state.user?.uid || "",
      workspaceId: workspaceId || null,
    };
  }

  function isCurrent(context) {
    return context.epoch === contextEpoch &&
      context.userId === (state.user?.uid || contextUserId) &&
      context.workspaceId === (state.selectedWorkspaceId || null) &&
      context.workspaceId === state.automations.selectedWorkspaceId &&
      (!context.runId || context.runId === state.automations.selectedRunId);
  }

  function resetSlice(workspaceId) {
    const next = createAutomationsState({selectedWorkspaceId: workspaceId || null});
    state.automations = next;
    if (workspaceId) updateStorageState(workspaceId);
    updatePollingState();
  }

  function setBusy(value, action = "") {
    state.automations.busy = value;
    state.automations.busyAction = value ? action : "";
    render();
  }

  function ensurePolling() {
    if (!pollTimer && typeof setIntervalImpl === "function") {
      pollTimer = setIntervalImpl(() => {
        return pollActiveRuns();
      }, POLL_INTERVAL_MS);
      pollTimer?.unref?.();
    }
    if (!visibilityAttached && documentImpl?.addEventListener) {
      documentImpl.addEventListener("visibilitychange", handleVisibilityChange);
      visibilityAttached = true;
    }
    updatePollingState();
  }

  function updatePollingState() {
    // Kept as a separate method so future surfaces can expose polling status
    // without creating a second Firestore listener or timer.
  }

  async function pollActiveRuns() {
    if (!isDocumentVisible() || !state.automations.selectedWorkspaceId || state.automations.history.loading) return null;
    const active = state.automations.history.runs.some((run) => ACTIVE_RUN_STATUSES.has(String(run.status || "").toLowerCase())) ||
      ACTIVE_RUN_STATUSES.has(String(state.automations.selectedRun?.status || "").toLowerCase());
    if (!active) return null;
    return loadHistory({silent: true});
  }

  function handleVisibilityChange() {
    if (isDocumentVisible()) void pollActiveRuns();
  }

  function isDocumentVisible() {
    return !documentImpl || documentImpl.visibilityState !== "hidden";
  }

  function clear() {
    contextEpoch += 1;
    actionKeys = new Map();
    resetSlice(null);
    render();
  }

  function dispose() {
    if (pollTimer && typeof clearIntervalImpl === "function") clearIntervalImpl(pollTimer);
    pollTimer = null;
    if (visibilityAttached && documentImpl?.removeEventListener) {
      documentImpl.removeEventListener("visibilitychange", handleVisibilityChange);
    }
    visibilityAttached = false;
    actionKeys = new Map();
  }
}
