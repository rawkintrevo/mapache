"use strict";

const path = require("path");

const PI_AUTH_PROVIDER_KEYS = Object.freeze([
  "anthropic",
  "ant-ling",
  "azure-openai-responses",
  "openai",
  "deepseek",
  "nvidia",
  "google",
  "mistral",
  "groq",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "xai",
  "openrouter",
  "vercel-ai-gateway",
  "zai",
  "zai-coding-cn",
  "opencode",
  "opencode-go",
  "huggingface",
  "fireworks",
  "together",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
  "openai-codex",
  "github-cli",
]);

const HARNESSES = Object.freeze({
  shell: Object.freeze({
    id: "shell",
    label: "Shell",
    terminalKind: "shell",
    auth: {supported: false},
    skills: {supported: false},
    mcp: {supported: false, sharedPath: ".mcp.json"},
    subagents: {supported: false},
    packages: {supported: false},
  }),
  ssh: Object.freeze({
    id: "ssh",
    label: "SSH",
    terminalKind: "ssh",
    auth: {supported: false},
    skills: {supported: false},
    mcp: {supported: false, sharedPath: ".mcp.json"},
    subagents: {supported: false},
    packages: {supported: false},
  }),
  pi: Object.freeze({
    id: "pi",
    label: "Pi",
    terminalKind: "pi",
    auth: {
      supported: true,
      storagePath: (config) => path.join(config.piAgentDir, "auth.json"),
      selectionField: "authSelection",
      providerKeys: PI_AUTH_PROVIDER_KEYS,
    },
    skills: {
      supported: true,
      relativePath: ".pi/skills",
      absolutePath: (config) => path.join(config.workspaceDir, ".pi", "skills"),
      legacyFileSupport: true,
      restartHint: "Restart Pi in the terminal if a running agent needs to rescan skills.",
    },
    mcp: {
      supported: true,
      sharedPath: ".mcp.json",
      harnessSpecificPath: ".pi/mcp.json",
    },
    subagents: {
      supported: true,
      relativePath: ".pi/agents",
      absolutePath: (config) => path.join(config.workspaceDir, ".pi", "agents"),
      fileExtension: ".md",
      schema: "pi-agent-markdown",
      restartHint: "Restart Pi in the terminal if a running agent should reload subagents.",
      chainsRelativePath: ".pi/chains",
      settingsRelativePath: ".pi/settings.json",
    },
    packages: {supported: true},
  }),
  codex: Object.freeze({
    id: "codex",
    label: "Codex",
    terminalKind: "codex",
    auth: {
      supported: true,
      storagePath: (config) => path.join(config.codexHomeDir, "auth.json"),
      selectionField: "authSelection",
      providerKeys: ["openai", "openai-codex", "github-cli"],
    },
    skills: {
      supported: true,
      relativePath: ".agents/skills",
      absolutePath: (config) => path.join(config.workspaceDir, ".agents", "skills"),
      legacyFileSupport: false,
      restartHint: "Restart Codex in the terminal if a running agent needs to rescan skills.",
    },
    mcp: {
      supported: true,
      sharedPath: ".mcp.json",
      harnessSpecificPath: ".codex/config.toml",
    },
    subagents: {
      supported: true,
      relativePath: ".codex/agents",
      absolutePath: (config) => path.join(config.workspaceDir, ".codex", "agents"),
      fileExtension: ".toml",
      schema: "codex-agent-toml",
      restartHint: "Restart Codex in the terminal if a running agent should reload subagents.",
      configPath: ".codex/config.toml",
    },
    packages: {supported: false},
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
