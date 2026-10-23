"use strict";

const {httpError} = require("./backendUtils.helpers");
const {normalizeEnvironmentEntryIds} = require("./environmentKeys.service");
const {isAutomationRuntime} = require("./runtimePaths.helpers");

// Resolve only selection metadata from the target's saved main session. Secret
// values remain in the owner-private stores and are materialized at startup.
async function resolveAutomationCredentialSelection({uid, workspace, sessions}) {
  const fallback = {
    environmentEntryIds: normalizeEnvironmentEntryIds(workspace.environmentEntryIds),
  };
  const sourceId = String(workspace.canonicalSessionId || workspace.agentRuntimeSessionId || "").trim();
  if (!sourceId) return fallback;
  if (sourceId.includes("/")) throw httpError(400, "automation_credential_source_invalid");
  const sourceSnap = await sessions.doc(sourceId).get();
  if (!sourceSnap.exists) return fallback;
  const source = sourceSnap.data() || {};
  if (source.ownerUid !== uid || isAutomationRuntime(source) ||
      source.workspaceId && source.workspaceId !== workspace.id) {
    throw httpError(403, "automation_credential_source_forbidden");
  }
  const selected = Array.isArray(source.environmentEntryIds) ? source.environmentEntryIds :
    Array.isArray(source.genericEnvironmentEntryIds) ? source.genericEnvironmentEntryIds :
      fallback.environmentEntryIds;
  const result = {environmentEntryIds: normalizeEnvironmentEntryIds(selected)};
  if (source.authSelection != null) {
    const {harness, providers} = source.authSelection;
    if (harness !== "pi" || !providers || typeof providers !== "object" || Array.isArray(providers) ||
        Object.values(providers).some((id) => typeof id !== "string" || !id.trim())) {
      throw httpError(400, "automation_credential_selection_invalid");
    }
    result.authSelection = {harness, providers: {...providers}};
  }
  return result;
}

module.exports = {resolveAutomationCredentialSelection};
