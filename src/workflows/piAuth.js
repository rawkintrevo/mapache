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
    const environment = await state.api.getGenericEnvironmentKeys();
    state.piAuth = {
      ...state.piAuth,
      loading: false,
      error: "",
      message: options.showMessage ? "Authentication providers refreshed." : "",
      providers: data.providers || {},
      entries: data.entries || {},
      environmentEntries: environment.entries || [],
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

export function updateGenericEnvironmentFormState(state, patch) {
  state.piAuth = {...state.piAuth, environmentForm: {...state.piAuth.environmentForm, ...patch}, error: "", message: ""};
}

export async function saveGenericEnvironmentKeyState({state, render}) {
  const form = state.piAuth.environmentForm || {};
  if (!String(form.name || "").trim() || !String(form.value || "")) {
    state.piAuth = {...state.piAuth, error: "Enter a variable name and secret value."}; render(); return;
  }
  state.piAuth = {...state.piAuth, saving: true, error: "", message: "Saving environment key..."}; render();
  try {
    const data = form.id ? await state.api.updateGenericEnvironmentKey(form.id, form) : await state.api.createGenericEnvironmentKey(form);
    await loadPiAuthState({state, render});
    state.piAuth = {...state.piAuth, saving: false, message: "Environment key saved. Select it for a session, then restart that runner to apply changes.", environmentForm: {id: "", name: "", label: "", value: ""}, lastEnvironmentEntry: data};
  } catch (error) { state.piAuth = {...state.piAuth, saving: false, error: friendlyPiAuthError(error), message: ""}; }
  render();
}

export function editGenericEnvironmentKeyState(state, entry) {
  state.piAuth = {...state.piAuth, environmentForm: {...entry, value: ""}, error: "", message: ""};
}

export async function deleteGenericEnvironmentKeyState({state, entryId, render}) {
  state.piAuth = {...state.piAuth, saving: true, error: "", message: "Deleting environment key..."}; render();
  try {
    await state.api.deleteGenericEnvironmentKey(entryId);
    await loadPiAuthState({state, render});
    state.piAuth = {...state.piAuth, saving: false, message: "Environment key deleted."};
    render();
  }
  catch (error) { state.piAuth = {...state.piAuth, saving: false, error: friendlyPiAuthError(error)}; render(); }
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
    const data = providerKey.startsWith("legacy-") ?
      await state.api.deletePiAuthProvider(providerKey.replace(/^legacy-/, "")) :
      await state.api.deletePiAuthEntry(providerKey);
    state.piAuth = {
      ...state.piAuth,
      saving: false,
      error: "",
      message: `${providerKey} deleted. New sessions will no longer materialize this credential automatically.`,
      providers: data.providers || {},
      entries: data.entries || {},
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
        message: "OpenAI Codex subscription login saved. New sessions can materialize it into the selected harness auth file.",
        providers: data.providers || state.piAuth.providers || {},
        entries: data.entries || state.piAuth.entries || {},
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
    const data = await state.api.savePiAuthProvider(provider, apiKey, state.piAuth.entryLabel || "");
    state.piAuth = {
      ...state.piAuth,
      saving: false,
      error: "",
      message: "API key saved. New sessions can materialize it into the selected harness auth file.",
      providers: data.providers || state.piAuth.providers || {},
      entries: data.entries || state.piAuth.entries || {},
      apiKey: "",
      entryLabel: "",
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

export async function saveSessionPiAuthSelectionState({state, session, selection, render}) {
  if (!state.api || !session?.workspaceId || !session?.id) return;
  state.piAuth = {...state.piAuth, saving: true, error: "", message: "Saving session auth selection..."};
  render();
  try {
    const data = await state.api.saveSessionPiAuthSelection(session.workspaceId, session.id, selection);
    state.sessions = state.sessions.map((item) => item.id === session.id ? {...item, authSelection: data.selection || selection, environmentEntryIds: selection.environmentEntryIds || []} : item);
    state.piAuth = {
      ...state.piAuth,
      saving: false,
      error: "",
      message: "Session auth selection saved. Restart the active harness if it should reload credentials.",
    };
    state.piAuthManageModalOpen = false;
  } catch (error) {
    state.piAuth = {...state.piAuth, saving: false, error: friendlyPiAuthError(error), message: ""};
  }
  render();
}
