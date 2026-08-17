import catalog from "../../functions/runnerCatalog.json";

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

export const sessionImages = catalog.images.map((image) => ({
  key: image.imageKey,
  imageKey: image.imageKey,
  harnessId: image.harnessId,
  label: image.label,
  variant: image.variant,
  value: image.image,
  terminalKind: catalog.harnesses?.[image.harnessId]?.terminalKind || "shell",
  capabilities: normalizeCapabilities(image.capabilities),
}));

function cleanSessionImageValue(value) {
  return String(value || "").trim().slice(0, 256);
}

function findSessionImage(imageValue) {
  const normalizedValue = cleanSessionImageValue(imageValue);
  return sessionImages.find((item) => item.value === normalizedValue || item.key === normalizedValue) || null;
}

export function sessionImageCapabilities(imageValue) {
  const image = findSessionImage(imageValue);
  return image ? image.capabilities : normalizeCapabilities({terminal: true});
}

export function normalizeSessionImageKey(session = {}) {
  const imageKey = cleanSessionImageValue(session.imageKey);
  if (imageKey) return imageKey;

  const legacyImage = findSessionImage(session.image);
  return legacyImage ? legacyImage.key : "";
}
