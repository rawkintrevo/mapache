import {describe, expect, test, vi} from "vitest";
import {createRequestGrantsController} from "../controllers/requestGrantsController.js";
import {createRequestGrantsState} from "../state/requestGrantsState.js";

test("loads, saves, and revokes directional grants for the selected source", async () => {
  const state = {
    selectedWorkspaceId: "source",
    requestGrants: createRequestGrantsState({targetWorkspaceId: "target", permissions: ["discover", "submit"]}),
    api: {
      getWorkspaceRequestGrants: vi.fn().mockResolvedValue([{targetWorkspaceId: "target", permissions: ["discover"]}]),
      saveWorkspaceRequestGrant: vi.fn().mockResolvedValue({}),
      revokeWorkspaceRequestGrant: vi.fn().mockResolvedValue({}),
    },
  };
  const render = vi.fn();
  const controller = createRequestGrantsController({state, render});

  await controller.load();
  expect(state.requestGrants.grants).toHaveLength(1);
  await controller.save();
  expect(state.api.saveWorkspaceRequestGrant).toHaveBeenCalledWith("source", "target", {permissions: ["discover", "submit"], enabled: true});
  await controller.revoke("target");
  expect(state.api.revokeWorkspaceRequestGrant).toHaveBeenCalledWith("source", "target");
});
