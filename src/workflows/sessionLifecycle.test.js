import {describe, expect, test, vi} from "vitest";
import {retryProvisioningSessionState} from "./sessionLifecycle.js";

describe("session retry workflow", () => {
  test("calls restart once without applying a stale response over listener state", async () => {
    const state = {
      selectedWorkspaceId: "workspace-1",
      sessions: [{id: "session-1", status: "provision_failed", provisioningRetryable: true}],
      api: {
        getSessions: vi.fn(),
        restartSession: vi.fn().mockResolvedValue({
          session: {id: "session-1", status: "running", serviceUrl: "https://stale.example"},
        }),
      },
    };

    await retryProvisioningSessionState(state, "session-1");

    expect(state.api.restartSession).toHaveBeenCalledOnce();
    expect(state.api.restartSession).toHaveBeenCalledWith("workspace-1", "session-1");
    expect(state.api.getSessions).not.toHaveBeenCalled();
    expect(state.sessions[0].status).toBe("provision_failed");
  });
});
