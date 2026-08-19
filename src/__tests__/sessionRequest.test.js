import {describe, expect, test} from "vitest";
import {createInitialState} from "../state/initialState.js";
import {createSessionRequestTracker, isCurrentSessionRequest} from "../utils/sessionRequest.js";

describe("session request identity", () => {
  test("invalidates an older request when the selected session changes", () => {
    const state = {...createInitialState(), selectedWorkspaceId: "workspace-1", selectedSessionId: "session-a"};
    const tracker = createSessionRequestTracker(state);
    const sessionA = tracker.capture();

    state.selectedSessionId = "session-b";
    const sessionB = tracker.capture();

    expect(sessionA.isCurrent()).toBe(false);
    expect(sessionB.isCurrent()).toBe(true);
    expect(isCurrentSessionRequest(sessionA)).toBe(false);
    expect(isCurrentSessionRequest(sessionB)).toBe(true);
  });

  test("invalidates a previous request even when the identity returns to the same session", () => {
    const state = {...createInitialState(), selectedWorkspaceId: "workspace-1", selectedSessionId: "session-a"};
    const tracker = createSessionRequestTracker(state);
    const first = tracker.capture();
    const second = tracker.capture();

    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });
});
