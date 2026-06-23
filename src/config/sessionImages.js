import catalog from "../../functions/runnerCatalog.json";

export const sessionImages = catalog.images.map((image) => ({
  key: image.imageKey,
  imageKey: image.imageKey,
  harnessId: image.harnessId,
  label: image.label,
  variant: image.variant,
  value: image.image,
  terminalKind: catalog.harnesses?.[image.harnessId]?.terminalKind || "shell",
  capabilities: {...(image.capabilities || {})},
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
  return image ? image.capabilities : {terminal: true, preview: false, previewQa: false, functions: false, n64: false};
}

export function normalizeSessionImageKey(session = {}) {
  const imageKey = cleanSessionImageValue(session.imageKey);
  if (imageKey) return imageKey;

  const legacyImage = findSessionImage(session.image);
  return legacyImage ? legacyImage.key : "";
}
