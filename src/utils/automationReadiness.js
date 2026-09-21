// Consume only the public workspace DTO. Bucket identity stays on the server.
export function automationStorageSummary(workspace = {}) {
  const storage = workspace.sharedStorage || {};
  return {
    configured: storage.configured === true,
    state: String(storage.state || workspace.sharedStorageState || "legacy").trim().toLowerCase(),
    errorCode: storage.errorCode || (storage.state ? null : workspace.sharedStorageErrorCode) || null,
  };
}

export function hasAutomationModel(automation = {}, workspace = {}) {
  const model = automation.modelSelection || workspace.automationModelSelection || workspace.modelSelection ||
    workspace.agentModelSelection || workspace.settings?.automation?.modelSelection;
  return Boolean(model?.modelId || model?.providerId);
}

export function automationReadiness({storage, busy = false, busyAction = "", modelConfigured = true, mutationBusy = busy}) {
  const ready = storage?.configured === true && storage.state === "ready";
  const validating = busyAction === "storage" || ["preparing", "migrating"].includes(storage?.state);
  let reason = "";
  if (validating) reason = "Shared storage validation is in progress. Wait for it to finish.";
  else if (busy) reason = busyAction === "load" || busyAction === "definitions" ?
    "Loading automation prerequisites. Wait for loading to finish." : "Saving automation changes. Wait for saving to finish.";
  else if (!storage?.configured) reason = "This workspace lacks required prepared shared storage. Ask an operator to provision it; this app has no storage provisioning flow.";
  else if (storage.state === "error") reason = `Shared storage validation failed${storage.errorCode ? ` (${storage.errorCode})` : ""}. Pause the workspace and revalidate shared storage; contact an operator if it still fails.`;
  else if (!ready) reason = "Shared storage needs validation. Pause the workspace, then choose Revalidate shared storage.";
  else if (!modelConfigured) reason = "Choose a model in the workspace Agent settings, then return here and Refresh before enabling or running this automation.";
  return {ready, canEnable: !reason, canRun: !reason, canDisable: !mutationBusy, reason};
}

export function automationErrorMessage(code = "") {
  if (code === "missing_model_selection") return "Choose a model in the workspace Agent settings, then return here and Refresh before enabling this automation.";
  if (code === "automation_shared_storage_not_ready") return "Shared storage is not ready. Refresh its status, then pause the workspace and revalidate existing shared storage.";
  if (code === "workspace_shared_storage_required") return "This workspace lacks required prepared shared storage. An operator must provision it before automations can be enabled.";
  if (code === "workspace_must_be_paused") return "Pause the workspace before revalidating shared storage.";
  return code;
}
