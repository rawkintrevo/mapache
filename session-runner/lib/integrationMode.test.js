"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  LEGACY_INTEGRATION_MODE,
  WEB_FIRST_INTEGRATION_MODE,
  assertSingleInteractiveOwner,
  resolveIntegrationMode,
} = require("./integrationMode");

test("missing runner mode preserves legacy behavior", () => {
  const result = resolveIntegrationMode({harnessId: "pi", chromeEnabled: true});
  assert.equal(result.mode, LEGACY_INTEGRATION_MODE);
  assert.equal(result.reason, "legacy_default");
});

test("web-first mode is restricted to pi-chrome", () => {
  assert.equal(resolveIntegrationMode({
    requestedMode: "web-first",
    harnessId: "pi",
    chromeEnabled: true,
  }).mode, WEB_FIRST_INTEGRATION_MODE);
  const unsupported = resolveIntegrationMode({
    requestedMode: "web-first",
    harnessId: "codex",
    chromeEnabled: true,
  });
  assert.equal(unsupported.mode, LEGACY_INTEGRATION_MODE);
  assert.equal(unsupported.reason, "web_first_requires_pi_chrome");
});

test("the composition rejects two interactive owners", () => {
  assert.throws(() => assertSingleInteractiveOwner({
    integrationMode: WEB_FIRST_INTEGRATION_MODE,
    goalsRpcActive: true,
    sharedAgentActive: true,
  }), /runner_interactive_owner_conflict/);
  assert.throws(() => assertSingleInteractiveOwner({
    integrationMode: WEB_FIRST_INTEGRATION_MODE,
    goalsRpcActive: true,
  }), /runner_goals_rpc_conflicts_with_web_first/);
  assert.equal(assertSingleInteractiveOwner({
    integrationMode: WEB_FIRST_INTEGRATION_MODE,
    sharedAgentActive: true,
  }), true);
  assert.equal(assertSingleInteractiveOwner({
    integrationMode: LEGACY_INTEGRATION_MODE,
    goalsRpcActive: true,
  }), true);
});
