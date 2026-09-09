import {
  friendlyPiInstallError,
  friendlyPiPackageError,
  friendlyPiRemoveError,
  friendlyPiUpdateError,
} from "../utils/friendlyErrors.js";

function update(state, piPackagesStore, patch) {
  piPackagesStore.update((current) => ({...current, ...patch}));
}

export function updatePiInstallSourceState(state, source, piPackagesStore) {
  update(state, piPackagesStore, {installSource: source, installMessage: "", error: ""});
}

export async function installPiPackageState({state, piPackagesStore, source, loadPiPackages}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  const packageSource = String(source || piPackagesStore.getState().installSource || "").trim();
  if (!workspaceId || !sessionId || !packageSource) {
    update(state, piPackagesStore, {
      error: packageSource ? "Start an active session before installing." : "Enter an npm: or git package source.",
    });
    return;
  }

  update(state, piPackagesStore, {installing: true, error: "", installMessage: "Installing package..."});
  try {
    await state.api.installPiPackage(workspaceId, sessionId, packageSource);
    update(state, piPackagesStore, {installing: false, installSource: "", installMessage: "Package installed into this workspace."});
    await loadPiPackages();
  } catch (error) {
    update(state, piPackagesStore, {installing: false, error: friendlyPiInstallError(error), installMessage: ""});
  }
}

export async function removePiPackageState({state, piPackagesStore, source, loadPiPackages}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  const packageSource = String(source || "").trim();
  if (!workspaceId || !sessionId || !packageSource) return;

  update(state, piPackagesStore, {installing: true, error: "", installMessage: "Removing package..."});
  try {
    await state.api.removePiPackage(workspaceId, sessionId, packageSource);
    update(state, piPackagesStore, {installing: false, installMessage: "Package removed from this workspace."});
    await loadPiPackages();
  } catch (error) {
    update(state, piPackagesStore, {installing: false, error: friendlyPiRemoveError(error), installMessage: ""});
  }
}

export async function updatePiPackageState({state, piPackagesStore, source = "", loadPiPackages}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  const packageSource = String(source || "").trim();
  if (!workspaceId || !sessionId) return;

  update(state, piPackagesStore, {
    installing: true,
    error: "",
    installMessage: packageSource ? "Updating package..." : "Updating workspace packages...",
  });
  try {
    await state.api.updatePiPackage(workspaceId, sessionId, packageSource);
    update(state, piPackagesStore, {
      installing: false,
      installMessage: packageSource ? "Package update complete." : "Workspace package update complete.",
    });
    await loadPiPackages();
  } catch (error) {
    update(state, piPackagesStore, {installing: false, error: friendlyPiUpdateError(error), installMessage: ""});
  }
}

export async function loadPiPackagesState({state, piPackagesStore}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId) {
    update(state, piPackagesStore, {
      loading: false,
      error: "Select or start an active session to inspect extensions.",
      unavailable: true,
      data: null,
    });
    return;
  }

  update(state, piPackagesStore, {loading: true, error: "", unavailable: false});
  try {
    const data = await state.api.getPiPackages(workspaceId, sessionId);
    update(state, piPackagesStore, {loading: false, error: "", unavailable: false, data: data || {packages: []}});
  } catch (error) {
    update(state, piPackagesStore, {loading: false, error: friendlyPiPackageError(error), unavailable: true, data: null});
  }
}
