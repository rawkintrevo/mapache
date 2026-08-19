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
      return {
        ...state,
        user: action.user || null,
        api: action.api || null,
        error: "",
      };
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
 * Keep a stable state facade while legacy domain workflows are migrated.
 * Reducers return immutable next-state objects; the facade is updated only at
 * the store boundary so existing workflow modules can retain their reference.
 */
export function createAppStore(initialState = createInitialState(), reducer = appReducer) {
  const state = {...initialState};
  const listeners = new Set();

  return {
    state,
    getState() {
      return state;
    },
    dispatch(action) {
      const nextState = reducer(state, action);
      if (nextState === state) return state;
      Object.assign(state, nextState);
      for (const listener of listeners) {
        listener(state, action);
      }
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
