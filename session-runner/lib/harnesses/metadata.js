"use strict";

const path = require("path");
const sharedCatalog = require("./generatedCatalog.json");

const PI_AUTH_PROVIDER_KEYS = Object.freeze(sharedCatalog.harnesses.pi.auth.providerKeys || []);

function sharedCapability(harnessId, capability, overrides = {}) {
  return {...(sharedCatalog.harnesses[harnessId]?.[capability] || {}), ...overrides};
}

const HARNESSES = Object.freeze({
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
});

function resolveHarnessMetadata(source = {}) {
  const explicitHarness = normalizeHarnessId(source.harnessId);
  if (explicitHarness && HARNESSES[explicitHarness]) return HARNESSES[explicitHarness];

  const terminalKind = normalizeHarnessId(source.terminalKind);
  const terminalHarness = Object.values(HARNESSES).find((harness) => harness.terminalKind === terminalKind);
  if (terminalHarness) return terminalHarness;

  return HARNESSES.pi;
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
