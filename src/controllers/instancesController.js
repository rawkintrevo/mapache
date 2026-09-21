import {createInstancesState} from "../state/initialState.js";
import {createInstancesApi} from "../services/instancesApi.js";

const POLL_INTERVAL_MS = 5_000;

/**
 * Owns the owner-wide active instance inventory opened from the user menu.
 * Requests are fenced by the authenticated user and controller epoch so a
 * logout or account switch cannot publish stale runtime data.
 */
export function createInstancesController({
  state,
  render = () => {},
  api,
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
  documentImpl = typeof document === "undefined" ? null : document,
} = {}) {
  if (!state) throw new Error("Instances controller requires app state.");

  let epoch = 0;
  let userId = state.user?.uid || "";
  let pollTimer = null;
  let visibilityAttached = false;
  let active = false;
  let requestSequence = 0;

  return {
    clear,
    dispose,
    getState: () => state.instances,
    load,
    loadNextPage,
    setFilters,
    setIdentity,
  };

  function getApi() {
    const client = api || state.api;
    if (!client) throw new Error("Authentication is required for instance requests.");
    return client.list ? client : createInstancesApi(client);
  }

  function setIdentity(uid = "") {
    const nextUserId = String(uid || "");
    if (nextUserId === userId) return;
    userId = nextUserId;
    clear();
  }

  async function load(options = {}) {
    const filters = options.filters ? {...options.filters} : {...state.instances.filters};
    const append = options.append === true;
    const requestedCursor = append ? state.instances.nextCursor : "";
    const context = {epoch, userId, filters, requestId: ++requestSequence};
    state.instances.loading = true;
    state.instances.error = "";
    if (!options.silent) render();
    ensurePolling();
    try {
      const data = await getApi().list({
        ...filters,
        ...(requestedCursor ? {cursor: requestedCursor} : {}),
      });
      if (!isCurrent(context)) return null;
      state.instances.filters = filters;
      state.instances.instances = append ? [...state.instances.instances, ...(data?.instances || [])] : (data?.instances || []);
      state.instances.nextCursor = data?.nextCursor || "";
      return state.instances;
    } catch (error) {
      if (isCurrent(context)) state.instances.error = error?.message || "Could not load running instances.";
      return null;
    } finally {
      if (isCurrent(context)) {
        state.instances.loading = false;
        render();
      }
    }
  }

  async function loadNextPage() {
    if (!state.instances.nextCursor || state.instances.loading) return null;
    return load({append: true});
  }

  async function setFilters(filters = {}) {
    state.instances.filters = {...filters};
    state.instances.nextCursor = "";
    return load({filters: state.instances.filters});
  }

  function ensurePolling() {
    active = true;
    if (!pollTimer && typeof setIntervalImpl === "function") {
      pollTimer = setIntervalImpl(() => {
        if (active && isDocumentVisible()) void load({silent: true});
      }, POLL_INTERVAL_MS);
      pollTimer?.unref?.();
    }
    if (!visibilityAttached && documentImpl?.addEventListener) {
      documentImpl.addEventListener("visibilitychange", handleVisibilityChange);
      visibilityAttached = true;
    }
  }

  function handleVisibilityChange() {
    if (active && isDocumentVisible()) void load({silent: true});
  }

  function isDocumentVisible() {
    return !documentImpl || documentImpl.visibilityState !== "hidden";
  }

  function isCurrent(context) {
    return context.epoch === epoch && context.userId === userId && context.userId === (state.user?.uid || "") && context.requestId === requestSequence;
  }

  function clear() {
    epoch += 1;
    requestSequence += 1;
    active = false;
    stopPolling();
    state.instances = createInstancesState();
    render();
  }

  function dispose() {
    active = false;
    stopPolling();
  }

  function stopPolling() {
    if (pollTimer && typeof clearIntervalImpl === "function") clearIntervalImpl(pollTimer);
    pollTimer = null;
    if (visibilityAttached && documentImpl?.removeEventListener) {
      documentImpl.removeEventListener("visibilitychange", handleVisibilityChange);
    }
    visibilityAttached = false;
  }
}
