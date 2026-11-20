import {describe, expect, it} from "vitest";
import {
  findSessionImage,
  normalizeSessionImageKey,
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

  it("maps the legacy runner key and tag to the canonical image", () => {
    expect(findSessionImage("pi-chrome")?.imageKey).toBe("gcp-runner");
    expect(findSessionImage("us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome")?.imageKey).toBe("gcp-runner");
    expect(normalizeSessionImageKey({imageKey: "pi-chrome"})).toBe("gcp-runner");
    expect(sessionHarness({imageKey: "pi-chrome"})?.id).toBe("pi");
  });

});
