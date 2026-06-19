export function normalizeSessionTerminalKind(session) {
  const terminalKind = String(session?.terminalKind || "").trim().toLowerCase();
  if (terminalKind === "pi" || terminalKind === "codex" || terminalKind === "shell") {
    return terminalKind;
  }

  const imageKey = String(session?.imageKey || "").trim().toLowerCase();
  if (imageKey.startsWith("codex-")) return "codex";
  if (imageKey.startsWith("pi-")) return "pi";

  const image = String(session?.image || "").trim().toLowerCase();
  if (/session-runner:codex-/.test(image)) return "codex";
  if (/session-runner:pi-/.test(image)) return "pi";

  return "shell";
}

export function sessionSkillHarness(session) {
  const terminalKind = normalizeSessionTerminalKind(session);
  if (terminalKind === "codex") {
    return {
      id: "codex",
      label: "Codex",
      managerLabel: "workspace-local skills",
      relativeSkillsPath: ".agents/skills",
      examplePath: "/workspace/.agents/skills/<name>/SKILL.md",
      restartHint: "Restart Codex in the terminal if a running agent needs to rescan skills.",
    };
  }
  if (terminalKind === "pi") {
    return {
      id: "pi",
      label: "Pi",
      managerLabel: "workspace-local skills",
      relativeSkillsPath: ".pi/skills",
      examplePath: "/workspace/.pi/skills/<name>/SKILL.md",
      restartHint: "Restart Pi in the terminal if a running agent needs to rescan skills.",
    };
  }
  return null;
}

export function sessionSupportsWorkspaceSkills(session) {
  return Boolean(sessionSkillHarness(session));
}
