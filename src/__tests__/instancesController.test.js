import {afterEach, describe, expect, test, vi} from "vitest";
import {createInstancesController} from "../controllers/instancesController.js";
import {createInitialState} from "../state/initialState.js";

function fixture() {
  const state = {
    ...createInitialState(),
    user: {uid: "user-1"},
  };
  const api = {
    list: vi.fn().mockResolvedValue({
      instances: [{id: "session-1", type: "main", status: "running"}],
      nextCursor: "next",
    }),
  };
  const document = {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return {state, api, document, render: vi.fn()};
}

afterEach(() => vi.restoreAllMocks());

describe("instancesController", () => {
  test("loads filtered pages and polls only while the document is visible", async () => {
    const fixtureData = fixture();
    let poll;
    const controller = createInstancesController({
      ...fixtureData,
      documentImpl: fixtureData.document,
      setIntervalImpl: (callback) => {
        poll = callback;
        return "poll";
      },
      clearIntervalImpl: vi.fn(),
    });

    await controller.setFilters({type: "automation", status: "running"});
    expect(fixtureData.api.list).toHaveBeenCalledWith({type: "automation", status: "running"});
    expect(fixtureData.state.instances.instances).toHaveLength(1);
    expect(fixtureData.state.instances.nextCursor).toBe("next");

    fixtureData.api.list.mockClear();
    fixtureData.document.visibilityState = "hidden";
    await poll();
    expect(fixtureData.api.list).not.toHaveBeenCalled();

    fixtureData.document.visibilityState = "visible";
    await poll();
    expect(fixtureData.api.list).toHaveBeenCalledWith({type: "automation", status: "running"});
    controller.dispose();
  });

  test("clears inventory on logout and ignores a late response", async () => {
    let resolve;
    const pending = new Promise((nextResolve) => { resolve = nextResolve; });
    const fixtureData = fixture();
    fixtureData.api.list.mockReturnValue(pending);
    const controller = createInstancesController({...fixtureData, setIntervalImpl: vi.fn()});
    const request = controller.load();

    fixtureData.state.user = null;
    controller.setIdentity("");
    resolve({instances: [{id: "stale"}], nextCursor: "stale"});
    await request;

    expect(fixtureData.state.instances.instances).toEqual([]);
    expect(fixtureData.state.instances.nextCursor).toBe("");
  });
});
