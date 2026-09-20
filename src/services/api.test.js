import {afterEach, describe, expect, test, vi} from "vitest";
import {createApiClient} from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 409 ? "Conflict" : "OK",
    json: vi.fn().mockResolvedValue(body),
  };
}

describe("automation API client", () => {
  test("sends manual idempotency keys and encodes workspace resources", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({run: {id: "run-1"}}));
    vi.stubGlobal("fetch", fetch);
    const client = createApiClient(async () => "firebase-token");

    await client.enqueueAutomationRun("workspace/1", "automation-1", {trigger: "manual"}, "manual-key");

    expect(fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace%2F1/automations/automation-1/run",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer firebase-token",
          "Idempotency-Key": "manual-key",
        }),
      }),
    );
  });

  test("preserves status, code, and response data for revision conflicts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({error: "revision_conflict"}, 409)));
    const client = createApiClient(async () => "firebase-token");

    await expect(client.updateAutomation("workspace-1", "automation-1", {expectedRevision: 2})).rejects.toMatchObject({
      code: "revision_conflict",
      status: 409,
      data: {error: "revision_conflict"},
    });
  });

  test("builds bounded history queries without leaking a client workspace override", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({runs: []}));
    vi.stubGlobal("fetch", fetch);
    const client = createApiClient(async () => "firebase-token");

    await client.listAutomationRuns({workspaceId: "workspace-1", status: "running", limit: 25, cursor: "next"});

    expect(fetch.mock.calls[0][0]).toBe(
      "/api/automation-runs?workspaceId=workspace-1&status=running&limit=25&cursor=next",
    );
  });
});
