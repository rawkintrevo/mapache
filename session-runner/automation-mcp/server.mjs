import {randomUUID} from "node:crypto";
import {McpServer} from "@modelcontextprotocol/server";
import {serveStdio} from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import {createAutomationAgentClient} from "./client.mjs";

const SERVER_NAME = "mapache-automations";
const SERVER_VERSION = "0.1.0";
const AUTOMATION_ID = z.string().min(1).max(200);
const REVISION = z.number().int().min(1);
const MODEL_SELECTION = z.object({
  modelId: z.string().min(1).max(256).optional(),
  providerId: z.string().min(1).max(256).optional(),
}).strict();
const RESOURCES = z.object({
  cpu: z.string().min(1).optional(),
  memory: z.string().min(1).optional(),
}).strict();
const MISSED_RUN_POLICY = z.enum(["skip", "latest"]);
const RETRY_POLICY = z.enum(["none", "safe"]);
const AUTOMATION_FIELDS = {
  name: z.string().min(1).max(120),
  prompt: z.string().min(1).max(32768),
  enabled: z.boolean().optional(),
  cron: z.string().min(1).max(100),
  timezone: z.string().min(1).max(100),
  allowParallelWithMain: z.boolean().optional(),
  modelSelection: MODEL_SELECTION.optional(),
  resources: RESOURCES.nullable().optional(),
  missedRunPolicy: MISSED_RUN_POLICY.optional(),
  catchUpWindowMinutes: z.number().int().min(1).max(10080).optional(),
  retryPolicy: RETRY_POLICY.optional(),
  maximumRetries: z.number().int().min(0).max(2).optional(),
  replaySafe: z.boolean().optional(),
};
const AUTOMATION_PATCH_FIELDS = {
  ...AUTOMATION_FIELDS,
  name: AUTOMATION_FIELDS.name.optional(),
  prompt: AUTOMATION_FIELDS.prompt.optional(),
  cron: AUTOMATION_FIELDS.cron.optional(),
  timezone: AUTOMATION_FIELDS.timezone.optional(),
  missedRunPolicy: AUTOMATION_FIELDS.missedRunPolicy,
  catchUpWindowMinutes: AUTOMATION_FIELDS.catchUpWindowMinutes,
  retryPolicy: AUTOMATION_FIELDS.retryPolicy,
  maximumRetries: AUTOMATION_FIELDS.maximumRetries,
  replaySafe: AUTOMATION_FIELDS.replaySafe,
};

function recoveryValidated(schema) {
  return schema.superRefine((value, context) => {
    if (value.retryPolicy === "safe" && value.replaySafe !== true) {
      context.addIssue({code: "custom", message: "retryPolicy=safe requires replaySafe=true", path: ["replaySafe"]});
    }
  });
}
const OCCURRENCE = z.object({
  local: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional(),
  utc: z.string().datetime().optional(),
  timezone: z.string().min(1).max(100).optional(),
}).strict();

const TOOL_NAMES = Object.freeze([
  "automations_list",
  "automations_get",
  "automations_create",
  "automations_update",
  "automations_delete",
  "automations_schedule_preview",
  "automations_settings_get",
  "automations_settings_update",
  "automations_run",
  "automation_runs_list",
  "automation_runs_get",
  "automation_runs_stop",
  "automation_runs_restart",
]);

export function createAutomationMcpServer({client = createAutomationAgentClient()} = {}) {
  const server = new McpServer(
      {name: SERVER_NAME, version: SERVER_VERSION},
      {capabilities: {tools: {}}},
  );
  registerAutomationTools(server, client);
  return server;
}

export function registerAutomationTools(server, client) {
  server.registerTool("automations_list", {
    description: "List the current workspace's saved automations.",
    inputSchema: z.object({}).strict(),
  }, () => invoke(() => client.call("/api/agent/automations")));

  server.registerTool("automations_get", {
    description: "Get one saved automation from the current workspace.",
    inputSchema: z.object({automationId: AUTOMATION_ID}),
  }, ({automationId}) => invoke(() => client.call(`/api/agent/automations/${encodeURIComponent(automationId)}`)));

  server.registerTool("automations_create", {
    description: "Create a saved workspace automation. Recovery defaults to skipping missed runs and no automatic retries. Schedule and recovery changes do not require a separate approval step.",
    inputSchema: recoveryValidated(z.object(AUTOMATION_FIELDS).strict()),
  }, (input) => invoke(() => client.call("/api/agent/automations", {method: "POST", body: input, retry: false})));

  server.registerTool("automations_update", {
    description: "Update a saved automation using its expected revision. Safe retries require replaySafe=true; they may repeat publication or sends and use current files.",
    inputSchema: recoveryValidated(z.object({automationId: AUTOMATION_ID, expectedRevision: REVISION, ...AUTOMATION_PATCH_FIELDS}).strict()),
  }, ({automationId, ...body}) => invoke(() => client.call(
      `/api/agent/automations/${encodeURIComponent(automationId)}`,
      {method: "PATCH", body, retry: false},
  )));

  server.registerTool("automations_delete", {
    description: "Delete a saved automation using its expected revision. Schedule changes do not require a separate approval step.",
    inputSchema: z.object({automationId: AUTOMATION_ID, expectedRevision: REVISION}),
  }, ({automationId, expectedRevision}) => invoke(() => client.call(
      `/api/agent/automations/${encodeURIComponent(automationId)}`,
      {method: "DELETE", body: {expectedRevision}, retry: false},
  )));

  server.registerTool("automations_schedule_preview", {
    description: "Preview the next five local and UTC occurrences of a cron schedule.",
    inputSchema: z.object({cron: z.string().min(1).max(100), timezone: z.string().min(1).max(100)}),
  }, ({cron, timezone}) => invoke(() => client.call("/api/agent/automation-schedule-preview", {
    method: "POST",
    body: {cron, timezone},
    retry: false,
  })));

  server.registerTool("automations_settings_get", {
    description: "Get automation queue and parallelism settings for the current workspace.",
    inputSchema: z.object({}).strict(),
  }, () => invoke(() => client.call("/api/agent/automation-settings")));

  server.registerTool("automations_settings_update", {
    description: "Update automation queue and parallelism settings for the current workspace.",
    inputSchema: z.object({automationMaxConcurrency: z.number().int().min(1)}).strict(),
  }, (body) => invoke(() => client.call("/api/agent/automation-settings", {
    method: "PATCH",
    body,
    retry: false,
  })));

  server.registerTool("automations_run", {
    description: "Run a saved automation now with a fresh conversation. The prompt's external side effects follow existing connection permissions.",
    inputSchema: z.object({automationId: AUTOMATION_ID, occurrence: OCCURRENCE.optional()}),
  }, ({automationId, occurrence}) => invoke(() => client.call(
      `/api/agent/automations/${encodeURIComponent(automationId)}/run`,
      {
        method: "POST",
        body: {trigger: "manual", ...(occurrence ? {occurrence} : {})},
        idempotencyKey: randomUUID(),
      },
  )));

  server.registerTool("automation_runs_list", {
    description: "List paginated automation runs from the current workspace.",
    inputSchema: z.object({
      automationId: AUTOMATION_ID.optional(),
      status: z.enum(["queued", "provisioning", "running", "stopping", "succeeded", "failed", "canceled", "interrupted", "skipped"]).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().max(4096).optional(),
    }).strict(),
  }, (query) => invoke(() => client.call(`/api/agent/automation-runs?${new URLSearchParams(stringifyQuery(query))}`)));

  server.registerTool("automation_runs_get", {
    description: "Get one automation run from the current workspace.",
    inputSchema: z.object({runId: AUTOMATION_ID}),
  }, ({runId}) => invoke(() => client.call(`/api/agent/automation-runs/${encodeURIComponent(runId)}`)));

  server.registerTool("automation_runs_stop", {
    description: "Stop a queued or active automation run.",
    inputSchema: z.object({runId: AUTOMATION_ID}),
  }, ({runId}) => invoke(() => client.call(`/api/agent/automation-runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST", body: {}, retry: false,
  })));

  server.registerTool("automation_runs_restart", {
    description: "Restart a terminal automation run in a fresh conversation.",
    inputSchema: z.object({runId: AUTOMATION_ID}),
  }, ({runId}) => invoke(() => client.call(`/api/agent/automation-runs/${encodeURIComponent(runId)}/restart`, {
    method: "POST", body: {}, idempotencyKey: randomUUID(),
  })));

  return server;
}

function stringifyQuery(query) {
  return Object.fromEntries(Object.entries(query || {}).filter(([, value]) => value !== undefined && value !== ""));
}

async function invoke(task) {
  try {
    const result = await task();
    return {
      content: [{type: "text", text: JSON.stringify(result)}],
      structuredContent: result,
    };
  } catch (error) {
    const body = error?.body && typeof error.body === "object" ? error.body : {};
    const details = {error: String(body.error || error?.code || "automation_agent_request_failed")};
    for (const field of ["pendingRunId", "runId"]) {
      if (typeof body[field] === "string" && body[field]) details[field] = body[field];
    }
    return {
      isError: true,
      content: [{type: "text", text: JSON.stringify(details)}],
      structuredContent: details,
    };
  }
}

export function startAutomationMcp() {
  return serveStdio(() => createAutomationMcpServer(), {
    onerror: (error) => console.error("automation MCP stdio error", error),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const handle = startAutomationMcp();
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export {SERVER_NAME, SERVER_VERSION, TOOL_NAMES};
