import {describe, expect, it, vi} from "vitest";
import {deleteGenericEnvironmentKeyState} from "../workflows/piAuth.js";

describe("generic environment key workflow", () => {
  it("re-enables key actions after a successful deletion", async () => {
    const render = vi.fn();
    const state = {
      api: {
        deleteGenericEnvironmentKey: vi.fn().mockResolvedValue({ok: true}),
        getPiAuth: vi.fn().mockResolvedValue({providers: {}, entries: {}}),
        getGenericEnvironmentKeys: vi.fn().mockResolvedValue({entries: []}),
      },
      piAuth: {
        saving: false,
        environmentEntries: [{id: "env-1", name: "SERVICE_TOKEN"}],
      },
    };

    await deleteGenericEnvironmentKeyState({state, entryId: "env-1", render});

    expect(state.api.deleteGenericEnvironmentKey).toHaveBeenCalledWith("env-1");
    expect(state.piAuth.saving).toBe(false);
    expect(state.piAuth.environmentEntries).toEqual([]);
    expect(state.piAuth.message).toBe("Environment key deleted.");
  });
});
