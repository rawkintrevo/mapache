"use strict";

const LEGACY_INTEGRATION_MODE = "legacy";
const WEB_FIRST_INTEGRATION_MODE = "web-first";
const INTEGRATION_MODES = Object.freeze([
  LEGACY_INTEGRATION_MODE,
  WEB_FIRST_INTEGRATION_MODE,
]);

function normalizeIntegrationMode(value) {
  return String(value || "").trim().toLowerCase() === WEB_FIRST_INTEGRATION_MODE ?
    WEB_FIRST_INTEGRATION_MODE : LEGACY_INTEGRATION_MODE;
}

/**
 * Resolve the runner's single interactive owner. Missing mode metadata is
 * intentionally legacy so an older session remains terminal-first after a
 * restart or image update.
 */
function resolveIntegrationMode({
  requestedMode,
  webFirstFlag = false,
  harnessId = "",
  chromeEnabled = false,
} = {}) {
  const requested = normalizeIntegrationMode(requestedMode || (webFirstFlag ? WEB_FIRST_INTEGRATION_MODE : LEGACY_INTEGRATION_MODE));
  const supportsWebFirst = String(harnessId || "").trim().toLowerCase() === "pi" && chromeEnabled === true;
  if (requested !== WEB_FIRST_INTEGRATION_MODE) {
    return {
      requested,
      mode: LEGACY_INTEGRATION_MODE,
      supportsWebFirst,
      reason: "legacy_default",
    };
  }
  if (!supportsWebFirst) {
    return {
      requested,
      mode: LEGACY_INTEGRATION_MODE,
      supportsWebFirst,
      reason: "web_first_requires_pi_chrome",
    };
  }
  return {
    requested,
    mode: WEB_FIRST_INTEGRATION_MODE,
    supportsWebFirst,
    reason: "explicit_web_first",
  };
}

function assertSingleInteractiveOwner({
  integrationMode,
  goalsRpcActive = false,
  sharedAgentActive = false,
} = {}) {
  const mode = normalizeIntegrationMode(integrationMode);
  if (goalsRpcActive && sharedAgentActive) {
    throw integrationModeError("runner_interactive_owner_conflict");
  }
  if (mode === WEB_FIRST_INTEGRATION_MODE && goalsRpcActive) {
    throw integrationModeError("runner_goals_rpc_conflicts_with_web_first");
  }
  if (mode === LEGACY_INTEGRATION_MODE && sharedAgentActive) {
    throw integrationModeError("runner_web_first_conflicts_with_legacy");
  }
  return true;
}

function integrationModeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {
  INTEGRATION_MODES,
  LEGACY_INTEGRATION_MODE,
  WEB_FIRST_INTEGRATION_MODE,
  assertSingleInteractiveOwner,
  normalizeIntegrationMode,
  resolveIntegrationMode,
};
