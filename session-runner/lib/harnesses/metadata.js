"use strict";

const path = require("path");
const sharedCatalog = require("./generatedCatalog.json");

const PI_AUTH_PROVIDER_KEYS = Object.freeze(sharedCatalog.harnesses.pi.auth.providerKeys || []);

function sharedCapability(harnessId, capability, overrides = {}) {
  return {...(sharedCatalog.harnesses[harnessId]?.[capability] || {}), ...overrides};
}

const HARNESSES = Object.freeze({
  shell: Object.freeze({
    id: "shell",
    label: "Shell",
    terminalKind: "shell",
    auth: sharedCapability("shell", "auth"),
    skills: sharedCapability("shell", "skills"),
    mcp: sharedCapability("shell", "mcp"),
    subagents: sharedCapability("shell", "subagents"),
    packages: sharedCapability("shell", "packages"),
  }),
  ssh: Object.freeze({
    id: "ssh",
    label: "SSH",
    terminalKind: "ssh",
    auth: sharedCapability("ssh", "auth"),
    skills: sharedCapability("ssh", "skills"),
    mcp: sharedCapability("ssh", "mcp"),
    subagents: sharedCapability("ssh", "subagents"),
    packages: sharedCapability("ssh", "packages"),
  }),
  pi: Object.freeze({
    id: "pi",
    label: "Pi",
    terminalKind: "pi",
    auth: sharedCapability("pi", "auth", {
      storagePath: (config) => path.join(config.piAgentDir, "auth.json"),
      selectionField: "authSelection",
      providerKeys: PI_AUTH_PROVIDER_KEYS,
    }),
    skills: sharedCapability("pi", "skills", {
      relativePath: ".pi/skills",
      absolutePath: (config) => path.join(config.workspaceDir, ".pi", "skills"),
      legacyFileSupport: true,
      restartHint: "Restart Pi in the terminal if a running agent needs to rescan skills.",
    }),
    mcp: sharedCapability("pi", "mcp", {
      sharedPath: ".mcp.json",
      harnessSpecificPath: ".pi/mcp.json",
    }),
    subagents: sharedCapability("pi", "subagents", {
      relativePath: ".pi/agents",
      absolutePath: (config) => path.join(config.workspaceDir, ".pi", "agents"),
      fileExtension: ".md",
      schema: "pi-agent-markdown",
      restartHint: "Restart Pi in the terminal if a running agent should reload subagents.",
      chainsRelativePath: ".pi/chains",
      settingsRelativePath: ".pi/settings.json",
    }),
    packages: sharedCapability("pi", "packages"),
  }),
  codex: Object.freeze({
    id: "codex",
    label: "Codex",
    terminalKind: "codex",
    auth: sharedCapability("codex", "auth", {
      storagePath: (config) => path.join(config.codexHomeDir, "auth.json"),
      selectionField: "authSelection",
      providerKeys: ["openai", "openai-codex", "github-cli"],
    }),
    skills: sharedCapability("codex", "skills", {
      relativePath: ".agents/skills",
      absolutePath: (config) => path.join(config.workspaceDir, ".agents", "skills"),
      legacyFileSupport: false,
      restartHint: "Restart Codex in the terminal if a running agent needs to rescan skills.",
    }),
    mcp: sharedCapability("codex", "mcp", {
      sharedPath: ".mcp.json",
      harnessSpecificPath: ".codex/config.toml",
    }),
    subagents: sharedCapability("codex", "subagents", {
      relativePath: ".codex/agents",
      absolutePath: (config) => path.join(config.workspaceDir, ".codex", "agents"),
      fileExtension: ".toml",
      schema: "codex-agent-toml",
      restartHint: "Restart Codex in the terminal if a running agent should reload subagents.",
      configPath: ".codex/config.toml",
    }),
    packages: sharedCapability("codex", "packages"),
  }),
});

function resolveHarnessMetadata(source = {}) {
  const explicitHarness = normalizeHarnessId(source.harnessId);
  if (explicitHarness && HARNESSES[explicitHarness]) return HARNESSES[explicitHarness];

  const terminalKind = normalizeHarnessId(source.terminalKind);
  const terminalHarness = Object.values(HARNESSES).find((harness) => harness.terminalKind === terminalKind);
  if (terminalHarness) return terminalHarness;

  return HARNESSES.shell;
}

function listHarnessMetadata() {
  return Object.values(HARNESSES);
}

function normalizeHarnessId(value) {
  return String(value || "").trim().toLowerCase();
}

module.exports = {
  HARNESSES,
  listHarnessMetadata,
  normalizeHarnessId,
  resolveHarnessMetadata,
};
