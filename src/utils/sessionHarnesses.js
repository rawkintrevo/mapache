import catalog from "../../functions/runnerCatalog.json";

const harnesses = catalog.harnesses || {};

function cleanValue(value) {
  return String(value || "").trim().toLowerCase();
}

function cloneHarness(harness) {
  if (!harness) return null;
  return {
    ...harness,
    auth: {...(harness.auth || {supported: false})},
    skills: {...(harness.skills || {supported: false})},
    mcp: {...(harness.mcp || {supported: false})},
    subagents: {...(harness.subagents || {supported: false})},
    packages: {...(harness.packages || {supported: false})},
  };
}

export function listSessionImages() {
  return catalog.images.map((image) => ({...image, capabilities: {...(image.capabilities || {})}}));
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
  return image ? {...(image.capabilities || {})} : {
    terminal: true,
    preview: false,
    previewQa: false,
    functions: false,
    n64: false,
  };
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

export function sessionSupportsWorkspaceSkills(session) {
  return Boolean(sessionHarness(session)?.skills?.supported);
}

export function sessionSupportsPackages(session) {
  return Boolean(sessionHarness(session)?.packages?.supported);
}

export function sessionSupportsSubagents(session) {
  return Boolean(sessionHarness(session)?.subagents?.supported);
}

export function sessionSkillHarness(session) {
  const harness = sessionHarness(session);
  if (!harness?.skills?.supported) return null;
  return {
    id: harness.id,
    label: harness.label,
    managerLabel: "workspace-local skills",
    relativeSkillsPath: harness.skills.relativePath,
    examplePath: harness.skills.examplePath,
    restartHint: harness.skills.restartHint,
  };
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

export function sessionSubagentHarness(session) {
  const harness = sessionHarness(session);
  if (!harness?.subagents?.supported) return null;
  return {
    id: harness.id,
    label: harness.label,
    relativePath: harness.subagents.relativePath,
    chainsRelativePath: harness.subagents.chainsRelativePath || "",
    settingsRelativePath: harness.subagents.settingsRelativePath || "",
    configPath: harness.subagents.configPath || "",
    schema: harness.subagents.schema || "",
    examplePath: harness.subagents.examplePath || "",
    restartHint: harness.subagents.restartHint || "",
  };
}
