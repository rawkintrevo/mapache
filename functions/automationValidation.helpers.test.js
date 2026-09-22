"use strict";

const assert = require("node:assert/strict");
const {
  buildAutomationDefinition,
  buildAutomationRun,
  normalizeAutomationMutation,
  normalizeAutomationSettings,
  validateAutomationMaxConcurrency,
  validateDefinitionRevision,
} = require("./automationValidation.helpers");

const baseDefinition = {
  name: "Nightly check",
  prompt: "Review the workspace and summarize changes.",
  cron: "0 10 * * *",
  timezone: "America/Chicago",
};

assert.deepEqual(normalizeAutomationMutation(baseDefinition), {
  ...baseDefinition,
  enabled: false,
  allowParallelWithMain: true,
  modelSelection: null,
  resources: null,
  missedRunPolicy: "skip",
  catchUpWindowMinutes: 1440,
  retryPolicy: "none",
  maximumRetries: 0,
  replaySafe: false,
});
assert.throws(() => normalizeAutomationMutation({...baseDefinition, prompt: "   "}), /invalid_automation_prompt/);
assert.throws(() => normalizeAutomationMutation({...baseDefinition, name: "x".repeat(121)}), /invalid_automation_name/);
assert.throws(() => normalizeAutomationMutation({...baseDefinition, prompt: "x".repeat(32769)}), /invalid_automation_prompt/);
assert.throws(() => normalizeAutomationMutation({...baseDefinition, ownerUid: "attacker"}), /automation_server_field/);
assert.throws(() => normalizeAutomationMutation({...baseDefinition, status: "running"}), /automation_server_field/);
assert.throws(() => normalizeAutomationMutation({...baseDefinition, surprise: true}), /unknown_automation_field/);
assert.throws(() => validateAutomationMaxConcurrency(1.5), /invalid_automation_max_concurrency/);
assert.throws(() => validateAutomationMaxConcurrency(0), /invalid_automation_max_concurrency/);
assert.throws(() => validateDefinitionRevision(0), /invalid_automation_revision/);

assert.deepEqual(buildAutomationDefinition(baseDefinition, {
  ownerUid: "user-1",
  workspaceId: "workspace-1",
  createdAt: "created",
  updatedAt: "updated",
}), {
  ownerUid: "user-1",
  workspaceId: "workspace-1",
  ...baseDefinition,
  enabled: false,
  allowParallelWithMain: true,
  modelSelection: null,
  resources: null,
  missedRunPolicy: "skip",
  catchUpWindowMinutes: 1440,
  retryPolicy: "none",
  maximumRetries: 0,
  replaySafe: false,
  revision: 1,
  deleted: false,
  deletedAt: null,
  nextRunAt: null,
  lastRunAt: null,
  lastRunId: null,
  createdAt: "created",
  updatedAt: "updated",
});

const run = buildAutomationRun({
  runId: "run-1",
  ownerUid: "user-1",
  workspaceId: "workspace-1",
  automationId: "automation-1",
  trigger: "cron",
  snapshot: {
    ...baseDefinition,
    definitionRevision: 2,
    allowParallelWithMain: true,
    modelSelection: null,
    resources: null,
  },
});
assert.equal(run.status, "queued");
assert.equal(run.cleanupState, "pending");
assert.equal(run.sessionId, null);
const initialAttempt = buildAutomationRun({}, {
  ...run, retryOfRunId: null, retryNotBefore: null, retryRunId: null,
  attemptNumber: 0, maximumRetries: 0, replaySafe: false,
});
assert.equal(initialAttempt.retryOfRunId, null);
assert.equal(initialAttempt.retryNotBefore, null);
assert.equal(initialAttempt.retryRunId, null);
assert.equal(initialAttempt.attemptNumber, 0);
assert.equal(initialAttempt.maximumRetries, 0);
assert.equal(initialAttempt.replaySafe, false);
assert.equal(Object.hasOwn(initialAttempt, "retryState"), false);
assert.equal(buildAutomationRun({...run, retryOfRunId: "old-run"}, {retryOfRunId: null}).retryOfRunId, null);
assert.equal(buildAutomationRun({...run, retryOfRunId: "old-run"}).retryOfRunId, "old-run");
const recoveredRun = buildAutomationRun({
  runId: "run-recovery",
  ownerUid: "user-1",
  workspaceId: "workspace-1",
  automationId: "automation-1",
  trigger: "cron",
  snapshot: {
    ...baseDefinition,
    definitionRevision: 3,
    missedRunPolicy: "latest",
    catchUpWindowMinutes: 60,
    retryPolicy: "safe",
    maximumRetries: 2,
    replaySafe: true,
  },
});
assert.deepEqual(recoveredRun.snapshot, {
  ...baseDefinition,
  definitionRevision: 3,
  allowParallelWithMain: true,
  modelSelection: null,
  resources: null,
  missedRunPolicy: "latest",
  catchUpWindowMinutes: 60,
  retryPolicy: "safe",
  maximumRetries: 2,
  replaySafe: true,
});
assert.deepEqual(normalizeAutomationSettings({}), {automationMaxConcurrency: 1});
assert.deepEqual(normalizeAutomationSettings({automationMaxConcurrency: 4}), {automationMaxConcurrency: 4});
assert.deepEqual(normalizeAutomationMutation({...baseDefinition, missedRunPolicy: "latest", catchUpWindowMinutes: 60}), {
  ...baseDefinition,
  enabled: false,
  allowParallelWithMain: true,
  modelSelection: null,
  resources: null,
  missedRunPolicy: "latest",
  catchUpWindowMinutes: 60,
  retryPolicy: "none",
  maximumRetries: 0,
  replaySafe: false,
});
assert.throws(() => normalizeAutomationMutation({...baseDefinition, retryPolicy: "safe"}), /automation_retry_requires_replay_safe/);
assert.deepEqual(normalizeAutomationMutation({...baseDefinition, retryPolicy: "safe", maximumRetries: 2, replaySafe: true}).retryPolicy, "safe");
assert.throws(() => normalizeAutomationMutation({...baseDefinition, maximumRetries: 3}), /invalid_automation_maximum_retries/);
assert.throws(() => normalizeAutomationMutation({...baseDefinition, sessionId: "private"}), /automation_server_field/);

console.log("automation validation helper tests passed");
