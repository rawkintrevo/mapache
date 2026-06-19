import {describe, expect, it} from "vitest";
import {friendlyGitStatusError} from "./friendlyErrors.js";

describe("friendlyGitStatusError", () => {
  it("maps runner busy errors to a specific retry message", () => {
    expect(friendlyGitStatusError(new Error("runner_busy_or_unavailable")))
        .toBe("The session runner is busy or unavailable right now. Try again in a few seconds.");
  });
});
