import assert from "node:assert/strict";
import test from "node:test";
import {AutomationAgentError, createAutomationAgentClient} from "./client.mjs";
import {registerAutomationTools, TOOL_NAMES} from "./server.mjs";

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, config, handler) {
      tools.set(name, {config, handler});
    },
  };
}

test("registers the bounded automation MCP contract without workspace parameters", async () => {
  const server = fakeServer();
  const calls = [];
  const client = {
    async call(path, options = {}) {
      calls.push({path, options});
      if (path === "/api/agent/automations") return {automations: []};
      if (path.includes("schedule-preview")) return {occurrences: [{local: "2026-09-21T09:00", utc: "2026-09-21T14:00:00.000Z", timezone: "America/Chicago"}]};
      if (path.includes("automation-settings")) return {automationMaxConcurrency: 2};
      if (path.includes("automation-runs")) return {runs: [], nextCursor: null};
      return {automation: {id: "automation-1", revision: 2}, run: {id: "run-1", status: "queued"}};
    },
  };
  registerAutomationTools(server, client);

  assert.deepEqual([...server.tools.keys()], TOOL_NAMES);
  for (const name of TOOL_NAMES) {
    assert.equal(typeof server.tools.get(name).handler, "function", name);
  }

  const result = await server.tools.get("automations_update").handler({
    automationId: "automation-1", expectedRevision: 2, enabled: true,
  });
  assert.equal(result.structuredContent.automation.id, "automation-1");
  const update = calls.at(-1);
  assert.equal(update.path, "/api/agent/automations/automation-1");
  assert.equal(update.options.body.workspaceId, undefined);
  assert.equal(update.options.body.expectedRevision, 2);

  await server.tools.get("automations_schedule_preview").handler({cron: "0 9 * * *", timezone: "America/Chicago"});
  const preview = calls.at(-1);
  assert.equal(preview.path, "/api/agent/automation-schedule-preview");
  assert.equal(preview.options.body.workspaceId, undefined);

  await server.tools.get("automation_runs_list").handler({status: "queued", limit: 10});
  const list = calls.at(-1);
  assert.match(list.path, /^\/api\/agent\/automation-runs\?/);
  assert.match(list.path, /status=queued/);
  assert.match(list.path, /limit=10/);
  assert.equal(list.path.includes("workspaceId"), false);
});

test("generates one manual idempotency key and exposes stable run identifiers", async () => {
  const server = fakeServer();
  const calls = [];
  registerAutomationTools(server, {
    async call(path, options) {
      calls.push({path, options});
      return {run: {id: "run-1", status: "queued"}};
    },
  });
  const result = await server.tools.get("automations_run").handler({automationId: "automation-1"});
  assert.deepEqual(result.structuredContent, {run: {id: "run-1", status: "queued"}});
  assert.equal(calls[0].options.body.trigger, "manual");
  assert.match(calls[0].options.idempotencyKey, /^[-\w]+$/);
  assert.equal(calls[0].options.body.workspaceId, undefined);

  await server.tools.get("automation_runs_restart").handler({runId: "run-1"});
  assert.notEqual(calls[1].options.idempotencyKey, calls[0].options.idempotencyKey);
});

test("returns stable error codes and safe link IDs", async () => {
  const server = fakeServer();
  registerAutomationTools(server, {
    async call() {
      throw new AutomationAgentError("pending_run_exists", {
        status: 409,
        body: {error: "pending_run_exists", pendingRunId: "run-pending", secret: "do-not-return"},
      });
    },
  });
  const result = await server.tools.get("automations_run").handler({automationId: "automation-1"});
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {error: "pending_run_exists", pendingRunId: "run-pending"});
  assert.equal(JSON.stringify(result).includes("do-not-return"), false);
});

test("retries a lost response with the same idempotency key", async () => {
  const requests = [];
  let attempt = 0;
  const client = createAutomationAgentClient({
    socketPath: "/tmp/automation-agent.sock",
    request: async (request) => {
      requests.push(request);
      attempt += 1;
      if (attempt === 1) throw new Error("response_lost");
      return {run: {id: "run-1"}};
    },
  });
  assert.deepEqual(await client.call("/api/agent/automations/automation-1/run", {
    method: "POST", body: {trigger: "manual"}, idempotencyKey: "fixed-key",
  }), {run: {id: "run-1"}});
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers["idempotency-key"], "fixed-key");
  assert.equal(requests[1].headers["idempotency-key"], "fixed-key");
  await assert.rejects(
      () => client.call("/api/workspaces/workspace-1/automations"),
      /automation_agent_invalid_path/,
  );
});
