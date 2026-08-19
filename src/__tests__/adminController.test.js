import {describe, expect, test, vi} from "vitest";
import {createAdminController} from "../controllers/adminController.js";
import {createAdminState} from "../state/initialState.js";

function createFixture(overrides = {}) {
  const state = {
    api: {
      getAdminUsers: vi.fn().mockResolvedValue({users: [], nextCursor: "", allowList: null}),
      setAdminUserWhitelisted: vi.fn().mockResolvedValue({user: null}),
    },
    profile: {isAdmin: true},
    admin: createAdminState({pageSize: 2, ...overrides}),
  };
  return {state, render: vi.fn(), dispatch: vi.fn()};
}

describe("createAdminController", () => {
  test("tracks cursors while moving forward and back", async () => {
    const fixture = createFixture({cursor: "", cursorStack: [], nextCursor: "cursor-1"});
    fixture.state.api.getAdminUsers
        .mockResolvedValueOnce({users: [{uid: "page-2"}], nextCursor: "cursor-2"})
        .mockResolvedValueOnce({users: [{uid: "page-1"}], nextCursor: "cursor-2"});
    const controller = createAdminController(fixture);

    await controller.nextAdminUsersPage();
    expect(fixture.state.api.getAdminUsers).toHaveBeenNthCalledWith(1, {
      cursor: "cursor-1",
      pageSize: 2,
    });
    expect(fixture.state.admin.cursor).toBe("cursor-1");
    expect(fixture.state.admin.cursorStack).toEqual([""]);

    await controller.previousAdminUsersPage();
    expect(fixture.state.api.getAdminUsers).toHaveBeenNthCalledWith(2, {
      cursor: "",
      pageSize: 2,
    });
    expect(fixture.state.admin.cursor).toBe("");
    expect(fixture.state.admin.cursorStack).toEqual([]);
  });

  test("updates the whitelisted user returned by the API", async () => {
    const fixture = createFixture({users: [{uid: "user-1", whitelisted: false}]});
    fixture.state.api.setAdminUserWhitelisted.mockResolvedValue({
      user: {uid: "user-1", whitelisted: true},
    });
    const controller = createAdminController(fixture);

    await controller.setAdminUserWhitelisted("user-1", true);

    expect(fixture.state.admin.users).toEqual([{uid: "user-1", whitelisted: true}]);
    expect(fixture.state.admin.loading).toBe(false);
  });

  test("leaves a useful error when whitelist mutation fails", async () => {
    const fixture = createFixture({users: [{uid: "user-1", whitelisted: false}]});
    fixture.state.api.setAdminUserWhitelisted.mockRejectedValue(new Error("permission_denied"));
    const controller = createAdminController(fixture);

    await controller.setAdminUserWhitelisted("user-1", true);

    expect(fixture.state.admin.loading).toBe(false);
    expect(fixture.state.admin.error).toBe("permission_denied");
  });

  test("selects the admin page and resets pagination when opened", async () => {
    const fixture = createFixture({cursor: "stale", cursorStack: ["older"]});
    const controller = createAdminController(fixture);

    await controller.showAdmin();

    expect(fixture.dispatch).toHaveBeenCalledWith({type: "app/setActivePage", page: "admin"});
    expect(fixture.state.api.getAdminUsers).toHaveBeenCalledWith({cursor: "", pageSize: 2});
  });
});
