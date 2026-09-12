import catalog from "../../functions/runnerCatalog.json";

const harnesses = catalog.harnesses || {};

function normalizeCapabilities(capabilities = {}) {
  return {
    terminal: Boolean(capabilities.terminal),
    preview: Boolean(capabilities.preview),
    previewQa: Boolean(capabilities.previewQa),
    functions: Boolean(capabilities.functions),
    n64: Boolean(capabilities.n64),
    chrome: Boolean(capabilities.chrome),
  };
}

function cleanValue(value) {
  return String(value || "").trim().toLowerCase();
}

function cloneHarness(harness) {
  if (!harness) return null;
  return {
    ...harness,
    auth: {...(harness.auth || {supported: false})},
    mcp: {...(harness.mcp || {supported: false})},
  };
}

export function listSessionImages() {
  return catalog.images.map((image) => ({...image, capabilities: normalizeCapabilities(image.capabilities)}));
}

export function findSessionImage(imageValue) {
  const normalizedValue = cleanValue(imageValue);
  return listSessionImages().find((item) => item.image === normalizedValue || item.imageKey === normalizedValue) || null;
}

export function normalizeSessionImageKey(session = {}) {
  const imageKey = cleanValue(session.imageKey);
  if (imageKey) return imageKey;

  const legacyImage = findSessionImage(session.image);
  return legacyImage ? legacyImage.imageKey : "";
}

export function sessionImageCapabilities(imageValue) {
  const image = findSessionImage(imageValue);
  return image ? normalizeCapabilities(image.capabilities) : normalizeCapabilities({terminal: true});
}

export function resolveHarness(harnessId) {
  return cloneHarness(harnesses[cleanValue(harnessId)] || null);
}

export function sessionHarness(session) {
  const explicitHarness = resolveHarness(session?.harnessId);
  if (explicitHarness) return explicitHarness;

  const terminalKind = cleanValue(session?.terminalKind);
  const terminalHarness = Object.values(harnesses).find((harness) => cleanValue(harness.terminalKind) === terminalKind);
  if (terminalHarness) return cloneHarness(terminalHarness);

  const image = findSessionImage(session?.imageKey || session?.image);
  if (image) return resolveHarness(image.harnessId);

  return resolveHarness("shell");
}

export function normalizeSessionTerminalKind(session) {
  return sessionHarness(session)?.terminalKind || "shell";
}

export function sessionSupportsAuth(session) {
  return Boolean(sessionHarness(session)?.auth?.supported);
}

export function sessionAuthHarness(session) {
  const harness = sessionHarness(session);
  if (!harness?.auth?.supported) return null;
  return {
    id: harness.id,
    label: harness.label,
    storagePath: harness.auth.storagePath,
    providerKeys: [...(harness.auth.providerKeys || [])],
    manageTitle: harness.auth.manageTitle,
    manageDescription: harness.auth.manageDescription,
    reloadHint: harness.auth.reloadHint,
  };
}
