import {McpServer} from "@modelcontextprotocol/server";
import {serveStdio} from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import {createGoogleWorkspaceConfig} from "./config.mjs";
import {createGoogleRestClient} from "./restClient.mjs";
import {registerCalendarReadTools} from "./calendar.mjs";
import {registerCalendarWriteTools} from "./calendarWrites.mjs";
import {registerGmailReadTools} from "./gmail.mjs";
import {registerGmailWriteTools} from "./gmailWrites.mjs";
import {registerDriveReadTools} from "./drive.mjs";
import {registerDriveWriteTools} from "./driveWrites.mjs";
import {registerDocsReadTools} from "./docs.mjs";
import {registerDocsWriteTools} from "./docsWrites.mjs";
import {registerSheetsReadTools} from "./sheets.mjs";
import {registerSheetsWriteTools} from "./sheetsWrites.mjs";
import {registerSlidesReadTools} from "./slides.mjs";
import {registerSlidesWriteTools} from "./slidesWrites.mjs";

const SERVER_NAME = "mapache-google-workspace";
const SERVER_VERSION = "0.1.0";

export function createGoogleWorkspaceServer(config = createGoogleWorkspaceConfig()) {
  const server = new McpServer(
      {name: SERVER_NAME, version: SERVER_VERSION},
      {capabilities: {tools: {}}},
  );

  if (config.enabledServices.length) server.registerTool(
      "google_workspace_health",
      {
        description: "Report whether the local Google Workspace MCP process is ready.",
        inputSchema: z.object({}),
        outputSchema: z.object({
          ok: z.boolean(),
          processReady: z.boolean(),
          checkedAt: z.string(),
          services: z.record(z.string(), z.object({
            state: z.string(),
            code: z.string(),
            status: z.number().optional(),
            reason: z.string().optional(),
          })),
        }),
      },
      async () => healthResult(client, config),
  );
  const client = createGoogleRestClient();
  registerCalendarReadTools(server, {client, config});
  registerCalendarWriteTools(server, {client, config});
  registerGmailReadTools(server, {client, config});
  registerGmailWriteTools(server, {client, config});
  registerDriveReadTools(server, {client, config});
  registerDriveWriteTools(server, {client, config});
  registerDocsReadTools(server, {client, config});
  registerDocsWriteTools(server, {client, config});
  registerSheetsReadTools(server, {client, config});
  registerSheetsWriteTools(server, {client, config});
  registerSlidesReadTools(server, {client, config});
  registerSlidesWriteTools(server, {client, config});

  return server;
}

async function healthResult(client, config) {
  const checkedAt = new Date().toISOString();
  const services = {};
  for (const serviceKey of config.enabledServices) {
    services[serviceKey] = await verifyService(client, serviceKey, config);
  }
  const ok = Object.values(services).every((service) => service.state === "verified");
  const result = {ok, processReady: true, checkedAt, services};
  return {
    content: [{type: "text", text: JSON.stringify(result)}],
    structuredContent: result,
  };
}

async function verifyService(client, serviceKey, config) {
  if (["docs", "sheets", "slides"].includes(serviceKey)) {
    return {state: "unverified", code: "google_service_unverified", reason: "resource_id_required"};
  }
  const probes = {
    drive: "/drive/v3/files?pageSize=1&fields=files(id)&q=trashed%20%3D%20false",
    gmail: "/gmail/v1/users/me/threads?maxResults=1",
    calendar: "/calendar/v3/users/me/calendarList?maxResults=1&fields=items(id)",
  };
  const path = probes[serviceKey];
  if (!path || !config.hasReadScope(serviceKey)) {
    return {state: "unverified", code: "google_scope_missing"};
  }
  try {
    await client.request(path);
    return {state: "verified", code: "ok"};
  } catch (error) {
    return {
      state: stateForError(error),
      code: safeErrorCode(error),
      ...(Number.isInteger(error?.status) && error.status > 0 ? {status: error.status} : {}),
    };
  }
}

function stateForError(error) {
  const code = String(error?.code || "");
  if (code === "google_unauthorized" || code === "google_token_refresh_failed" || code === "google_access_token_missing") return "expired";
  if (code === "google_forbidden") return "forbidden";
  if (code === "google_rate_limited") return "rate_limited";
  if (String(code).includes("reconnect")) return "reconnect_required";
  if (error?.status >= 500 || code.includes("timeout") || code.includes("unavailable")) return "upstream_error";
  return "request_failed";
}

function safeErrorCode(error) {
  const code = String(error?.code || "google_service_check_failed");
  return /^google_[a-z0-9_]{1,100}$/.test(code) ? code : "google_service_check_failed";
}

export function startGoogleWorkspaceMcp() {
  return serveStdio(() => createGoogleWorkspaceServer(), {
    onerror: (error) => console.error("Google Workspace MCP stdio error", error),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const handle = startGoogleWorkspaceMcp();
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
