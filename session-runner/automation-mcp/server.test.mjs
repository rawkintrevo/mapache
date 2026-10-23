import assert from "node:assert/strict";
import test from "node:test";
import {AutomationAgentError, createAutomationAgentClient} from "./client.mjs";
import {registerAutomationTools, TOOL_NAMES, waitForWorkspaceRequest} from "./server.mjs";

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
  assert.throws(() => server.tools.get("automations_create").config.inputSchema.parse({
    name: "Daily",
    prompt: "Check files.",
    cron: "0 9 * * *",
    timezone: "UTC",
    retryPolicy: "safe",
  }), /replaySafe/);

  const result = await server.tools.get("automations_update").handler({
    automationId: "automation-1", expectedRevision: 2, enabled: true,
  });
  assert.equal(result.structuredContent.automation.id, "automation-1");
  const update = calls.at(-1);
  assert.equal(update.path, "/api/agent/automations/automation-1");
  assert.equal(update.options.body.workspaceId, undefined);
  assert.equal(update.options.body.expectedRevision, 2);

  await server.tools.get("automations_update").handler({
    automationId: "automation-1",
    expectedRevision: 2,
    catchUpWindowMinutes: 60,
    maximumRetries: 2,
    missedRunPolicy: "latest",
    replaySafe: true,
    retryPolicy: "safe",
  });
  assert.deepEqual(calls.at(-1).options.body, {
    catchUpWindowMinutes: 60,
    expectedRevision: 2,
    maximumRetries: 2,
    missedRunPolicy: "latest",
    replaySafe: true,
    retryPolicy: "safe",
  });

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

test("workspace information request guidance uses existing discovery, submission and result contracts", async () => {
  const server = fakeServer();
  const calls = [];
  registerAutomationTools(server, {
    async call(path, options = {}) {
      calls.push({path, options});
      if (path.endsWith("/targets")) return {targets: [{workspaceId: "research", name: "Customer Research"}]};
      if (options.method === "POST") return {id: "answer-1", status: "queued"};
      return {id: "answer-1", status: "succeeded", result: {summary: "Three onboarding themes"}};
    },
  });
  const invoke = (name, input) => {
    const tool = server.tools.get(name);
    return tool.handler(tool.config.inputSchema.parse(input));
  };
  const targets = await invoke("workspace_request_targets", {});
  const targetWorkspaceId = targets.structuredContent.targets[0].workspaceId;
  const submitted = await invoke("workspace_request_submit", {
    targetWorkspaceId,
    request: "Summarize onboarding complaints from last month.",
    desiredOutput: "Main themes and three supporting examples with sources.",
    idempotencyKey: "information-question-1",
  });
  assert.equal(submitted.structuredContent.status, "queued");
  assert.equal(calls[1].options.body.targetWorkspaceId, "research");
  assert.equal(calls[1].options.idempotencyKey, "information-question-1");
  const answer = await invoke("workspace_request_get", {ticketId: submitted.structuredContent.id});
  assert.equal(calls[2].path, "/api/agent/workspace-requests/answer-1");
  assert.equal(answer.structuredContent.result.summary, "Three onboarding themes");

  const denied = fakeServer();
  registerAutomationTools(denied, {async call() {
    throw Object.assign(new Error("Denied"), {code: "request_permission_denied"});
  }});
  const failure = await denied.tools.get("workspace_request_submit").handler({targetWorkspaceId, request: "Question"});
  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent.error, "request_permission_denied");
});

test("workspace request model discovery returns the target catalog before submission", async () => {
  const server = fakeServer();
  const calls = [];
  registerAutomationTools(server, {
    async call(path, options = {}) {
      calls.push({path, options});
      return {
        targetWorkspaceId: "research",
        savedModelSelection: {providerId: "openai", modelId: "gpt-5"},
        models: [{providerId: "openai", modelId: "gpt-5", name: "GPT-5", available: true}],
      };
    },
  });
  const tool = server.tools.get("workspace_request_models");
  const result = await tool.handler(tool.config.inputSchema.parse({targetWorkspaceId: "research"}));
  assert.deepEqual(result.structuredContent.savedModelSelection, {providerId: "openai", modelId: "gpt-5"});
  assert.equal(result.structuredContent.models[0].name, "GPT-5");
  assert.equal(calls[0].path, "/api/agent/workspace-requests/models?targetWorkspaceId=research");
});

test("workspace request ask submits once and waits for the durable ticket result", async () => {
  const server = fakeServer();
  const calls = [];
  const notifications = [];
  registerAutomationTools(server, {
    async call(path, options = {}) {
      calls.push({path, options});
      if (options.method === "POST") return {request: {id: "ticket-1", status: "queued"}};
      return {request: {id: "ticket-1", status: "succeeded", result: {answer: "Ready"}}};
    },
  });
  const tool = server.tools.get("workspace_request_ask");
  const result = await tool.handler(tool.config.inputSchema.parse({
    targetWorkspaceId: "research",
    targetWorkspaceName: "Customer Research",
    request: "Summarize the findings.",
    idempotencyKey: "research-summary-1",
    timeoutSeconds: 1,
  }), {mcpReq: {_meta: {progressToken: "progress-1"}, notify: async (notification) => notifications.push(notification)}});
  assert.equal(result.structuredContent.request.result.answer, "Ready");
  assert.equal(calls.filter(({options}) => options.method === "POST").length, 1);
  assert.equal(calls[0].options.idempotencyKey, "research-summary-1");
  assert.equal(calls[0].options.body.targetWorkspaceName, undefined);
  assert.equal(calls[1].path, "/api/agent/workspace-requests/ticket-1");
  assert.match(notifications[0].params.message, /Waiting for Customer Research: queued · 0s elapsed/);
  assert.equal(notifications.at(-1).params.progressToken, "progress-1");
});

test("workspace request wait preserves the ticket when its deadline expires", async () => {
  let clock = 0;
  const result = await waitForWorkspaceRequest({async call() {
    return {request: {id: "ticket-1", status: "running"}};
  }}, "ticket-1", 5, {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.deepEqual(result, {
    request: {id: "ticket-1", status: "running"},
    waitExpired: true,
    ticketId: "ticket-1",
  });
});

test("workspace request wait returns terminal failures without resubmission", async () => {
  const result = await waitForWorkspaceRequest({async call(path) {
    assert.equal(path, "/api/agent/workspace-requests/ticket-1");
    return {request: {id: "ticket-1", status: "failed", errorCode: "automation_execution_failed"}};
  }}, "ticket-1", 600);
  assert.deepEqual(result.request, {
    id: "ticket-1",
    status: "failed",
    errorCode: "automation_execution_failed",
  });
});
