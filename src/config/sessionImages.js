export const sessionImages = [
  {
    key: "default",
    label: "Shell",
    value: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest",
    terminalKind: "shell",
    capabilities: {
      terminal: true,
      preview: false,
      previewQa: false,
      functions: false,
    },
  },
  {
    key: "pi-basic",
    label: "pi-basic",
    value: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-basic",
    terminalKind: "pi",
    capabilities: {
      terminal: true,
      preview: false,
      previewQa: false,
      functions: false,
    },
  },
  {
    key: "codex-basic",
    label: "codex-basic",
    value: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:codex-basic",
    terminalKind: "codex",
    capabilities: {
      terminal: true,
      preview: false,
      previewQa: false,
      functions: false,
    },
  },
  {
    key: "pi-web",
    label: "pi-web",
    value: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-web",
    terminalKind: "pi",
    capabilities: {
      terminal: true,
      preview: true,
      previewQa: true,
      functions: true,
    },
  },
  {
    key: "codex-web",
    label: "codex-web",
    value: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:codex-web",
    terminalKind: "codex",
    capabilities: {
      terminal: true,
      preview: true,
      previewQa: true,
      functions: true,
    },
  },
  {
    key: "pi-n64",
    label: "pi-n64",
    value: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-n64",
    terminalKind: "pi",
    capabilities: {
      terminal: true,
      preview: true,
      previewQa: false,
      functions: false,
      n64: true,
    },
  },
];

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
