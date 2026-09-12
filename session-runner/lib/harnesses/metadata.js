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
    mcp: sharedCapability("shell", "mcp"),
  }),
  ssh: Object.freeze({
    id: "ssh",
    label: "SSH",
    terminalKind: "ssh",
    auth: sharedCapability("ssh", "auth"),
    mcp: sharedCapability("ssh", "mcp"),
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
    mcp: sharedCapability("pi", "mcp", {
      sharedPath: ".mcp.json",
      harnessSpecificPath: ".pi/mcp.json",
    }),
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
    mcp: sharedCapability("codex", "mcp", {
      sharedPath: ".mcp.json",
      harnessSpecificPath: ".codex/config.toml",
    }),
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
