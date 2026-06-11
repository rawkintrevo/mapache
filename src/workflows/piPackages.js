import {
  friendlyPiInstallError,
  friendlyPiPackageError,
  friendlyPiRemoveError,
  friendlyPiUpdateError,
} from "../utils/friendlyErrors.js";

export function updatePiInstallSourceState(state, source) {
  state.piPackages = {
    ...state.piPackages,
    installSource: source,
    installMessage: "",
    error: "",
  };
}

export async function installPiPackageState({state, source, loadPiPackages, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  const packageSource = String(source || state.piPackages.installSource || "").trim();
  if (!workspaceId || !sessionId || !packageSource) {
    state.piPackages = {
      ...state.piPackages,
      error: packageSource ? "Start an active session before installing." : "Enter an npm: or git package source.",
    };
    render();
    return;
  }

  state.piPackages = {
    ...state.piPackages,
    installing: true,
    error: "",
    installMessage: "Installing package...",
  };
  render();

  try {
    await state.api.installPiPackage(workspaceId, sessionId, packageSource);
    state.piPackages = {
      ...state.piPackages,
      installing: false,
      installSource: "",
      installMessage: "Package installed into this workspace.",
    };
    await loadPiPackages();
  } catch (error) {
    state.piPackages = {
      ...state.piPackages,
      installing: false,
      error: friendlyPiInstallError(error),
      installMessage: "",
    };
    render();
  }
}

export async function removePiPackageState({state, source, loadPiPackages, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  const packageSource = String(source || "").trim();
  if (!workspaceId || !sessionId || !packageSource) return;

  state.piPackages = {
    ...state.piPackages,
    installing: true,
    error: "",
    installMessage: "Removing package...",
  };
  render();

  try {
    await state.api.removePiPackage(workspaceId, sessionId, packageSource);
    state.piPackages = {
      ...state.piPackages,
      installing: false,
      installMessage: "Package removed from this workspace.",
    };
    await loadPiPackages();
  } catch (error) {
    state.piPackages = {
      ...state.piPackages,
      installing: false,
      error: friendlyPiRemoveError(error),
      installMessage: "",
    };
    render();
  }
}

export async function updatePiPackageState({state, source = "", loadPiPackages, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  const packageSource = String(source || "").trim();
  if (!workspaceId || !sessionId) return;

  state.piPackages = {
    ...state.piPackages,
    installing: true,
    error: "",
    installMessage: packageSource ? "Updating package..." : "Updating workspace packages...",
  };
  render();

  try {
    await state.api.updatePiPackage(workspaceId, sessionId, packageSource);
    state.piPackages = {
      ...state.piPackages,
      installing: false,
      installMessage: packageSource ? "Package update complete." : "Workspace package update complete.",
    };
    await loadPiPackages();
  } catch (error) {
    state.piPackages = {
      ...state.piPackages,
      installing: false,
      error: friendlyPiUpdateError(error),
      installMessage: "",
    };
    render();
  }
}

export async function loadPiPackagesState({state, resetPiPackages, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId) {
    state.piPackages = {
      ...state.piPackages,
      loading: false,
      error: "Select or start an active session to inspect extensions.",
      unavailable: true,
      data: null,
    };
    render();
    return;
  }

  state.piPackages = {
    ...state.piPackages,
    loading: true,
    error: "",
    unavailable: false,
    data: state.piPackages.data || null,
  };
  render();

  try {
    const data = await state.api.getPiPackages(workspaceId, sessionId);
    state.piPackages = {
      ...state.piPackages,
      loading: false,
      error: "",
      unavailable: false,
      data: data || {packages: []},
    };
  } catch (error) {
    state.piPackages = {
      ...state.piPackages,
      loading: false,
      error: friendlyPiPackageError(error),
      unavailable: true,
      data: null,
    };
  }
  render();
}
