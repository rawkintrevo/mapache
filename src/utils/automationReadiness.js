// Consume only the public workspace DTO. Bucket identity stays on the server.
export function automationStorageSummary(workspace = {}) {
  const storage = workspace.sharedStorage || {};
  return {
    configured: storage.configured === true,
    state: String(storage.state || workspace.sharedStorageState || "legacy").trim().toLowerCase(),
    errorCode: storage.errorCode || (storage.state ? null : workspace.sharedStorageErrorCode) || null,
  };
}

export function automationModelSelection(automation = {}, workspace = {}) {
  return automation.modelSelection || workspace.automationModelSelection || workspace.modelSelection ||
    workspace.agentModelSelection || workspace.settings?.automation?.modelSelection || null;
}

export function hasAutomationModel(automation = {}, workspace = {}) {
  const model = automationModelSelection(automation, workspace);
  return Boolean(model?.modelId?.trim() && model?.providerId?.trim());
}

export function automationReadiness({busy = false, busyAction = "", modelConfigured = true, mutationBusy = busy}) {
  let reason = "";
  if (busy) reason = busyAction === "load" || busyAction === "definitions" ?
    "Loading automation settings. Wait for loading to finish." : "Saving automation changes. Wait for saving to finish.";
  else if (!modelConfigured) reason = "Choose a provider and model in this automation's editor before enabling or running it.";
  return {ready: true, canEnable: !reason, canRun: !reason, canDisable: !mutationBusy, reason};
}

export function automationErrorMessage(code = "") {
  if (code === "missing_model_selection") return "Choose a provider and model in this automation's editor before enabling it.";
  return code;
}
