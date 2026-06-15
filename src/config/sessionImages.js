export const sessionImages = [
  {
    label: "Default runner",
    value: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest",
    capabilities: {
      terminal: true,
      preview: false,
      previewQa: false,
      functions: false,
    },
  },
  {
    label: "pi-basic",
    value: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-basic",
    capabilities: {
      terminal: true,
      preview: false,
      previewQa: false,
      functions: false,
    },
  },
  {
    label: "pi-web",
    value: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-web",
    capabilities: {
      terminal: true,
      preview: true,
      previewQa: true,
      functions: true,
    },
  },
  {
    label: "pi-n64",
    value: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-n64",
    capabilities: {
      terminal: true,
      preview: true,
      previewQa: false,
      functions: false,
      n64: true,
    },
  },
];

export function sessionImageCapabilities(imageValue) {
  const image = sessionImages.find((item) => item.value === imageValue);
  return image ? image.capabilities : {terminal: true, preview: false, previewQa: false, functions: false, n64: false};
}
