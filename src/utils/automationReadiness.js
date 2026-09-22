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

export function automationReadiness({busy = false, busyAction = "", modelConfigured = true, mutationBusy = busy}) {
  let reason = "";
  if (busy) reason = busyAction === "load" || busyAction === "definitions" ?
    "Loading automation settings. Wait for loading to finish." : "Saving automation changes. Wait for saving to finish.";
  else if (!modelConfigured) reason = "Choose a model in the workspace Agent settings, then return here and Refresh before enabling or running this automation.";
  return {ready: true, canEnable: !reason, canRun: !reason, canDisable: !mutationBusy, reason};
}

export function automationErrorMessage(code = "") {
  if (code === "missing_model_selection") return "Choose a model in the workspace Agent settings, then return here and Refresh before enabling this automation.";
  return code;
}
