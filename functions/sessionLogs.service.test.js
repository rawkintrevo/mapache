"use strict";

const assert = require("node:assert/strict");
const {createSessionLogsService, safeRequestPath} = require("./sessionLogs.service");

(async () => {
  const requests = [];
  const service = createSessionLogsService({
    projectId: "project-1",
    requireSession: async (uid, workspaceId, sessionId) => {
      assert.deepStrictEqual([uid, workspaceId, sessionId], ["user-1", "workspace-1", "session-1"]);
      return {sessionSnap: {data: () => ({serviceId: "session-safe-1"})}};
    },
    auth: {
      getClient: async () => ({
        request: async (request) => {
          requests.push(request);
          return {data: {entries: [
            {
              insertId: "entry-1",
              timestamp: "2026-09-13T15:00:00Z",
              severity: "ERROR",
              textPayload: "runner failed\u0000 to start",
            },
            {
              insertId: "entry-2",
              timestamp: "2026-09-13T14:59:00Z",
              httpRequest: {
                requestMethod: "GET",
                requestUrl: "https://runner.example/agent/?mapache_access=secret",
                status: 503,
              },
            },
          ]}};
        },
      }),
    },
  });

  const result = await service.listSessionLogs("user-1", "workspace-1", "session-1", {limit: "900"});
  assert.strictEqual(requests[0].url, "https://logging.googleapis.com/v2/entries:list");
  assert.strictEqual(requests[0].data.pageSize, 500);
  assert.match(requests[0].data.filter, /service_name="session-safe-1"/);
  assert.deepStrictEqual(result, {
    serviceId: "session-safe-1",
    logs: [
      {id: "entry-1", timestamp: "2026-09-13T15:00:00Z", severity: "ERROR", message: "runner failed to start"},
      {id: "entry-2", timestamp: "2026-09-13T14:59:00Z", severity: "DEFAULT", message: "GET /agent/ 503"},
    ],
  });
  assert.strictEqual(safeRequestPath("https://runner.example/browser/?mapache_access=secret"), "/browser/");

  await assert.rejects(
      createSessionLogsService({
        requireSession: async () => ({sessionSnap: {data: () => ({serviceId: "invalid/service"})}}),
      }).listSessionLogs("user-1", "workspace-1", "session-1"),
      (error) => error.status === 404 && error.publicMessage === "session_logs_unavailable",
  );

  console.log("session logs service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
