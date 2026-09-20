import {describe, expect, it, vi} from "vitest";
import {browserTimezone, ensureUserTimezone} from "./userTimezone.js";

describe("user timezone initialization", () => {
  it("returns a browser timezone or UTC fallback", () => {
    expect(browserTimezone()).toEqual(expect.any(String));
    expect(browserTimezone()).not.toEqual("");
  });

  it("does not overwrite an existing profile timezone", async () => {
    const updateTimezone = vi.fn();
    const profile = {uid: "user-1", timezone: "Europe/London"};
    await expect(ensureUserTimezone({profile, updateTimezone})).resolves.toBe(profile);
    expect(updateTimezone).not.toHaveBeenCalled();
  });

  it("persists a missing timezone once and keeps the returned profile", async () => {
    const profile = {uid: "user-1"};
    const updateTimezone = vi.fn().mockResolvedValue({user: {...profile, timezone: "UTC"}});
    await expect(ensureUserTimezone({profile, updateTimezone})).resolves.toEqual({...profile, timezone: "UTC"});
    expect(updateTimezone).toHaveBeenCalledWith(expect.any(String));
  });
});
