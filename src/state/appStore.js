import {createInitialState} from "./initialState.js";

export const APP_ACTIONS = Object.freeze({
  SET_IDENTITY: "app/setIdentity",
  SET_PROFILE: "app/setProfile",
  SET_SELECTED_WORKSPACE: "app/setSelectedWorkspace",
  SET_SELECTED_SESSION: "app/setSelectedSession",
  SET_ACTIVE_PAGE: "app/setActivePage",
  SET_BUSY: "app/setBusy",
  SET_ERROR: "app/setError",
  RESET_SIGNED_OUT: "app/resetSignedOut",
});

export function appReducer(state, action = {}) {
  switch (action.type) {
    case APP_ACTIONS.SET_IDENTITY:
      return {...state, user: action.user || null, api: action.api || null, error: ""};
    case APP_ACTIONS.SET_PROFILE:
      return {...state, profile: action.profile || null};
    case APP_ACTIONS.SET_SELECTED_WORKSPACE:
      return {...state, selectedWorkspaceId: action.workspaceId || null};
    case APP_ACTIONS.SET_SELECTED_SESSION:
      return {...state, selectedSessionId: action.sessionId || null};
    case APP_ACTIONS.SET_ACTIVE_PAGE:
      return {...state, activePage: action.page || "workspace"};
    case APP_ACTIONS.SET_BUSY:
      return {
        ...state,
        busy: Boolean(action.busy),
        busyMessage: action.busy ? action.message || "Working..." : "",
      };
    case APP_ACTIONS.SET_ERROR:
      return {...state, error: action.error || ""};
    case APP_ACTIONS.RESET_SIGNED_OUT:
      return {
        ...state,
        user: null,
        profile: null,
        api: null,
        selectedWorkspaceId: null,
        selectedSessionId: null,
        activePage: "workspace",
        busy: false,
        busyMessage: "",
        error: "",
      };
    default:
      return state;
  }
}

/**
 * Provides a stable facade for legacy state consumers while all writes cross
 * one observable store boundary. Domain migrations can use updateSlice rather
 * than mutating the facade directly.
 */
export function createAppStore(initialState = createInitialState(), reducer = appReducer) {
  const state = {...initialState};
  const listeners = new Set();

  function publish(nextState, action) {
    if (nextState === state) return state;
    Object.assign(state, nextState);
    for (const listener of listeners) listener(state, action);
    return state;
  }

  return {
    state,
    getState: () => state,
    dispatch(action) {
      return publish(reducer(state, action), action);
    },
    updateSlice(name, updater, type = `app/update/${name}`) {
      const current = state[name];
      const next = typeof updater === "function" ? updater(current) : updater;
      if (next === current) return state;
      return publish({...state, [name]: next}, {type, name});
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
