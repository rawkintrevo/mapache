"use strict";

const DEFAULT_RUNNER_IMAGE_KEY = "default";

const RUNNER_IMAGES = {
  [DEFAULT_RUNNER_IMAGE_KEY]: {
    key: DEFAULT_RUNNER_IMAGE_KEY,
    label: "Default runner",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest",
    capabilities: {
      terminal: true,
      preview: false,
      previewQa: false,
      functions: false,
    },
  },
  "pi-basic": {
    key: "pi-basic",
    label: "pi-basic",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-basic",
    capabilities: {
      terminal: true,
      preview: false,
      previewQa: false,
      functions: false,
    },
  },
  "pi-web": {
    key: "pi-web",
    label: "pi-web",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-web",
    capabilities: {
      terminal: true,
      preview: true,
      previewQa: true,
      functions: true,
    },
  },
  "pi-n64": {
    key: "pi-n64",
    label: "pi-n64",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-n64",
    capabilities: {
      terminal: true,
      preview: true,
      previewQa: false,
      functions: false,
      n64: true,
    },
  },
};

const RUNNER_IMAGES_BY_IMAGE = Object.values(RUNNER_IMAGES).reduce((acc, runnerImage) => {
  acc[runnerImage.image] = runnerImage;
  return acc;
}, {});

function cloneCapabilities(capabilities) {
  return {
    terminal: Boolean(capabilities && capabilities.terminal),
    preview: Boolean(capabilities && capabilities.preview),
    previewQa: Boolean(capabilities && capabilities.previewQa),
    functions: Boolean(capabilities && capabilities.functions),
    n64: Boolean(capabilities && capabilities.n64),
  };
}

function runnerImageCapabilities(image) {
  const runnerImage = RUNNER_IMAGES_BY_IMAGE[cleanRunnerImageValue(image)];
  return runnerImage ? cloneCapabilities(runnerImage.capabilities) : {
    terminal: true,
    preview: false,
    previewQa: false,
    functions: false,
    n64: false,
  };
}

function resolveRunnerImage(payload = {}, defaultImage = "") {
  const requestedKey = cleanRunnerImageValue(payload.imageKey);
  if (requestedKey) {
    const runnerImage = RUNNER_IMAGES[requestedKey];
    if (!runnerImage) throw invalidRunnerImageError();
    return resolvedRunnerImage(runnerImage);
  }

  const legacyImage = cleanRunnerImageValue(payload.image);
  if (legacyImage) {
    const runnerImage = RUNNER_IMAGES_BY_IMAGE[legacyImage] || RUNNER_IMAGES[legacyImage];
    if (!runnerImage) throw invalidRunnerImageError();
    return resolvedRunnerImage(runnerImage);
  }

  const configuredDefaultImage = cleanRunnerImageValue(defaultImage);
  if (!configuredDefaultImage) {
    return {
      key: "",
      image: "",
      capabilities: runnerImageCapabilities(""),
      canProvision: false,
    };
  }

  const runnerImage = RUNNER_IMAGES_BY_IMAGE[configuredDefaultImage];
  if (runnerImage) return resolvedRunnerImage(runnerImage);

  return {
    key: "configured-default",
    image: configuredDefaultImage,
    capabilities: runnerImageCapabilities(configuredDefaultImage),
    canProvision: true,
  };
}

function resolvedRunnerImage(runnerImage) {
  return {
    key: runnerImage.key,
    image: runnerImage.image,
    capabilities: cloneCapabilities(runnerImage.capabilities),
    canProvision: true,
  };
}

function invalidRunnerImageError() {
  const error = new Error("invalid_runner_image");
  error.code = "invalid_runner_image";
  return error;
}

function cleanRunnerImageValue(value) {
  return String(value || "").trim().slice(0, 256);
}

module.exports = {
  DEFAULT_RUNNER_IMAGE_KEY,
  RUNNER_IMAGES,
  resolveRunnerImage,
  runnerImageCapabilities,
};
