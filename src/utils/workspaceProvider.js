const REMOTE_PROVIDER_TYPES = new Set(["remote-libvirt", "remote-vm"]);

export function workspaceRuntimeBackend(workspace = {}) {
  return String(
      workspace.runtimeProvider?.backend ||
      workspace.runtimeBackend ||
      workspace.source?.type ||
      "",
  ).trim().toLowerCase();
}

export function isRemoteVmWorkspace(workspace = {}) {
  return REMOTE_PROVIDER_TYPES.has(workspaceRuntimeBackend(workspace));
}

export function isReadyRemoteHost(host = {}) {
  return host.ready === true || String(host.status || "").trim().toLowerCase() === "ready";
}
