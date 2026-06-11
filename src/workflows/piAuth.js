import {friendlyPiAuthError} from "../utils/friendlyErrors.js";

export async function loadPiAuthState({state, render, options = {}}) {
  if (!state.api) return;
  state.piAuth = {
    ...state.piAuth,
    loading: true,
    error: "",
    message: options.showMessage ? "Refreshing authentication providers..." : state.piAuth.message,
  };
  render();

  try {
    const data = await state.api.getPiAuth();
    state.piAuth = {
      ...state.piAuth,
      loading: false,
      error: "",
      message: options.showMessage ? "Authentication providers refreshed." : "",
      providers: data.providers || {},
    };
  } catch (error) {
    state.piAuth = {
      ...state.piAuth,
      loading: false,
      error: friendlyPiAuthError(error),
      message: "",
    };
  }
  render();
}

export function updatePiAuthFormState(state, patch) {
  state.piAuth = {
    ...state.piAuth,
    ...patch,
    error: "",
    message: "",
  };
}

export async function savePiAuthProviderState({state, render}) {
  const provider = String(state.piAuth.selectedProvider || "").trim();
  const apiKey = String(state.piAuth.apiKey || "").trim();
  if (!provider || !apiKey) {
    state.piAuth = {
      ...state.piAuth,
      error: provider ? "Enter an API key." : "Choose a provider.",
      message: "",
    };
    render();
    return;
  }

  state.piAuth = {
    ...state.piAuth,
    saving: true,
    error: "",
    message: "Saving API key...",
  };
  render();

  try {
    const data = await state.api.savePiAuthProvider(provider, apiKey);
    state.piAuth = {
      ...state.piAuth,
      saving: false,
      error: "",
      message: "API key saved. New sessions will materialize it into Pi auth.json.",
      providers: data.providers || state.piAuth.providers || {},
      apiKey: "",
    };
  } catch (error) {
    state.piAuth = {
      ...state.piAuth,
      saving: false,
      error: friendlyPiAuthError(error),
      message: "",
    };
  }
  render();
}
