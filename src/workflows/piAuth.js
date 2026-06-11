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

export async function deletePiAuthProviderState({state, provider, render}) {
  const providerKey = String(provider || "").trim();
  if (!state.api || !providerKey) return;
  state.piAuth = {
    ...state.piAuth,
    saving: true,
    error: "",
    message: `Deleting ${providerKey}...`,
  };
  render();

  try {
    const data = await state.api.deletePiAuthProvider(providerKey);
    state.piAuth = {
      ...state.piAuth,
      saving: false,
      error: "",
      message: `${providerKey} deleted. New sessions will no longer materialize it into Pi auth.json.`,
      providers: data.providers || {},
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

export async function startOpenAiCodexDeviceLoginState({state, render}) {
  if (!state.api) return;
  state.piAuth = {
    ...state.piAuth,
    saving: true,
    error: "",
    message: "Starting OpenAI Codex device login...",
    openAiCodexDevice: null,
  };
  render();

  try {
    const device = await state.api.startOpenAiCodexDeviceLogin();
    state.piAuth = {
      ...state.piAuth,
      saving: false,
      error: "",
      message: "Enter the code at OpenAI, then keep this window open while authorization completes.",
      openAiCodexDevice: {...device, status: "pending"},
    };
    render();
    await pollOpenAiCodexLoginState({state, render});
  } catch (error) {
    state.piAuth = {
      ...state.piAuth,
      saving: false,
      error: friendlyPiAuthError(error),
      message: "",
      openAiCodexDevice: null,
    };
    render();
  }
}

async function pollOpenAiCodexLoginState({state, render}) {
  const device = state.piAuth.openAiCodexDevice;
  if (!device?.deviceAuthId || !device?.userCode) return;
  const startedAt = Date.now();
  const timeoutMs = Number(device.expiresInSeconds || 900) * 1000;
  const intervalMs = Math.max(1, Number(device.intervalSeconds || 5)) * 1000;

  while (Date.now() - startedAt < timeoutMs) {
    await wait(intervalMs);
    const current = state.piAuth.openAiCodexDevice;
    if (current?.deviceAuthId !== device.deviceAuthId) return;
    try {
      const data = await state.api.completeOpenAiCodexDeviceLogin(device.deviceAuthId, device.userCode);
      if (data.status === "pending") {
        state.piAuth = {
          ...state.piAuth,
          message: "Waiting for OpenAI authorization...",
          openAiCodexDevice: {...device, status: "pending"},
        };
        render();
        continue;
      }
      state.piAuth = {
        ...state.piAuth,
        saving: false,
        error: "",
        message: "OpenAI Codex subscription login saved. New sessions will materialize it into Pi auth.json.",
        providers: data.providers || state.piAuth.providers || {},
        openAiCodexDevice: {...device, status: "complete"},
      };
      render();
      return;
    } catch (error) {
      state.piAuth = {
        ...state.piAuth,
        saving: false,
        error: friendlyPiAuthError(error),
        message: "",
        openAiCodexDevice: {...device, status: "error"},
      };
      render();
      return;
    }
  }

  state.piAuth = {
    ...state.piAuth,
    saving: false,
    error: "OpenAI Codex login timed out. Start a new login and try again.",
    message: "",
    openAiCodexDevice: {...device, status: "expired"},
  };
  render();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      openAiCodexDevice: null,
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
