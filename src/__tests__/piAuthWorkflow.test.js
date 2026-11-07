import {describe, expect, it, vi} from "vitest";
import {
  deleteGenericEnvironmentKeyState,
  saveGenericEnvironmentKeyState,
  updateGenericEnvironmentSelectionState,
} from "../workflows/piAuth.js";

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

  it("selects a saved key for the active session", async () => {
    const render = vi.fn();
    const saveSessionPiAuthSelection = vi.fn().mockResolvedValue({
      selection: {harness: "pi", providers: {}},
    });
    const state = {
      api: {
        createGenericEnvironmentKey: vi.fn().mockResolvedValue({id: "env-1", name: "SERVICE_TOKEN"}),
        getPiAuth: vi.fn().mockResolvedValue({providers: {}, entries: {}}),
        getGenericEnvironmentKeys: vi.fn().mockResolvedValue({entries: [{id: "env-1", name: "SERVICE_TOKEN"}]}),
        saveSessionPiAuthSelection,
      },
      selectedSessionId: "session-1",
      sessions: [{id: "session-1", workspaceId: "workspace-1", harnessId: "pi", environmentEntryIds: []}],
      piAuth: {
        saving: false,
        environmentForm: {name: "SERVICE_TOKEN", label: "Service", value: "secret"},
      },
    };

    await saveGenericEnvironmentKeyState({state, render});

    expect(saveSessionPiAuthSelection).toHaveBeenCalledWith("workspace-1", "session-1", {
      environmentEntryIds: ["env-1"],
    });
    expect(state.sessions[0].environmentEntryIds).toEqual(["env-1"]);
    expect(state.piAuth.message).toMatch(/saved and selected/);
  });

  it("can remove the final key selection from a session", async () => {
    const render = vi.fn();
    const saveSessionPiAuthSelection = vi.fn().mockResolvedValue({selection: {harness: "shell", providers: {}}});
    const state = {
      api: {saveSessionPiAuthSelection},
      selectedSessionId: "session-1",
      sessions: [{id: "session-1", workspaceId: "workspace-1", harnessId: "shell", environmentEntryIds: ["env-1"]}],
      piAuth: {saving: false},
    };

    await updateGenericEnvironmentSelectionState({state, entryId: "env-1", selected: false, render});

    expect(saveSessionPiAuthSelection).toHaveBeenCalledWith("workspace-1", "session-1", {
      environmentEntryIds: [],
    });
    expect(state.sessions[0].environmentEntryIds).toEqual([]);
  });
});

for (const selection of [undefined, {harness: "pi", providers: {}}, {harness: "pi", providers: {google: "entry-1"}}]) {
  for (const action of ["create", "enable", "disable", "delete"]) {
    it(`preserves ${JSON.stringify(selection)} auth when environment action is ${action}`, async () => {
      const session = {id: "s", workspaceId: "w", environmentEntryIds: ["env-1"],
        ...(selection === undefined ? {} : {authSelection: selection})};
      const state = {selectedSessionId: "s", sessions: [session], piAuth: {
        environmentForm: {name: "QA_VAR", value: "fixture"},
      }, api: {
        createGenericEnvironmentKey: vi.fn().mockResolvedValue({id: "env-2"}),
        deleteGenericEnvironmentKey: vi.fn().mockResolvedValue({ok: true}),
        getPiAuth: vi.fn().mockResolvedValue({}),
        getGenericEnvironmentKeys: vi.fn().mockResolvedValue({entries: []}),
        saveSessionPiAuthSelection: vi.fn().mockResolvedValue({ok: true}),
      }};
      const render = vi.fn();
      if (action === "create") await saveGenericEnvironmentKeyState({state, render});
      else if (action === "delete") await deleteGenericEnvironmentKeyState({state, entryId: "env-1", render});
      else await updateGenericEnvironmentSelectionState({state, entryId: "env-1", selected: action === "enable", render});
      expect(state.api.saveSessionPiAuthSelection.mock.calls[0][2]).toEqual({
        environmentEntryIds: action === "create" ? ["env-1", "env-2"] : action === "enable" ? ["env-1"] : [],
      });
      expect(state.sessions[0].authSelection).toEqual(selection);
      expect(Object.hasOwn(state.sessions[0], "authSelection")).toBe(selection !== undefined);
    });
  }
}

it("does not replace newer auth state when an environment save finishes", async () => {
  const newer = {harness: "pi", providers: {google: "new-entry"}};
  const state = {selectedSessionId: "s", sessions: [{id: "s", workspaceId: "w"}], piAuth: {}, api: {
    saveSessionPiAuthSelection: vi.fn(async () => {
      state.sessions = [{...state.sessions[0], authSelection: newer}];
      return {ok: true};
    }),
  }};
  await updateGenericEnvironmentSelectionState({state, entryId: "env", selected: true, render: vi.fn()});
  expect(state.sessions[0].authSelection).toEqual(newer);
});
