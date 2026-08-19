import {createInitialState} from "./initialState.js";

export const APP_ACTIONS = Object.freeze({
  END_OPERATION: "app/endOperation",
  SET_IDENTITY: "app/setIdentity",
  SET_PROFILE: "app/setProfile",
  SET_SELECTED_WORKSPACE: "app/setSelectedWorkspace",
  SET_SELECTED_SESSION: "app/setSelectedSession",
  SET_ACTIVE_PAGE: "app/setActivePage",
  START_OPERATION: "app/startOperation",
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
    case APP_ACTIONS.START_OPERATION: {
      const key = String(action.key || "global");
      const current = state.pendingOperations[key];
      const nextSequence = (state.operationSequence || 0) + 1;
      return {
        ...state,
        operationSequence: nextSequence,
        pendingOperations: {
          ...state.pendingOperations,
          [key]: {
            count: (current?.count || 0) + 1,
            message: action.message || current?.message || "Working...",
            order: nextSequence,
          },
        },
      };
    }
    case APP_ACTIONS.END_OPERATION: {
      const key = String(action.key || "global");
      const current = state.pendingOperations[key];
      if (!current) return state;
      const pendingOperations = {...state.pendingOperations};
      if (current.count > 1) {
        pendingOperations[key] = {...current, count: current.count - 1};
      } else {
        delete pendingOperations[key];
      }
      return {
        ...state,
        pendingOperations,
      };
    }
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
        pendingOperations: {},
        operationSequence: 0,
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
