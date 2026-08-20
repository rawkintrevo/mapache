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
        outputSchema: z.object({ok: z.boolean()}),
      },
      async () => ({
        content: [{type: "text", text: JSON.stringify({ok: true})}],
        structuredContent: {ok: true},
      }),
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

  return server;
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
