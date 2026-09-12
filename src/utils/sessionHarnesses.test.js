import {describe, expect, it} from "vitest";
import {
  sessionAuthHarness,
  sessionHarness,
} from "./sessionHarnesses.js";

describe("sessionHarnesses", () => {
  it("prefers persisted harnessId", () => {
    expect(sessionHarness({harnessId: "pi", terminalKind: "pi"})?.id).toBe("pi");
  });

  it("returns auth metadata for auth-capable harnesses", () => {
    expect(sessionAuthHarness({harnessId: "pi"})?.storagePath).toContain(".pi/agent/auth.json");
    expect(sessionAuthHarness({harnessId: "pi"})?.providerKeys).toContain("github-cli");
    expect(sessionAuthHarness({harnessId: "pi"})?.providerKeys).toContain("openai-codex");
  });

});
