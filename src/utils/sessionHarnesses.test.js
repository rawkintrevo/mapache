import {describe, expect, it} from "vitest";
import {
  sessionAuthHarness,
  sessionHarness,
  sessionSkillHarness,
  sessionSubagentHarness,
  sessionSupportsPackages,
} from "./sessionHarnesses.js";

describe("sessionHarnesses", () => {
  it("prefers persisted harnessId", () => {
    expect(sessionHarness({harnessId: "codex", terminalKind: "pi"})?.id).toBe("codex");
  });

  it("falls back to image metadata", () => {
    expect(sessionSkillHarness({imageKey: "pi-web"})?.relativeSkillsPath).toBe(".pi/skills");
    expect(sessionSubagentHarness({imageKey: "codex-basic"})?.schema).toBe("codex-agent-toml");
  });

  it("returns auth metadata for auth-capable harnesses", () => {
    expect(sessionAuthHarness({harnessId: "pi"})?.storagePath).toContain(".pi/agent/auth.json");
    expect(sessionAuthHarness({harnessId: "shell"})).toBeNull();
  });

  it("reports package support from harness metadata", () => {
    expect(sessionSupportsPackages({harnessId: "pi"})).toBe(true);
    expect(sessionSupportsPackages({harnessId: "codex"})).toBe(false);
  });
});
