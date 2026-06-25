"use strict";

const catalog = require("./runnerCatalog.json");

const DEFAULT_RUNNER_IMAGE_KEY = "default";

const HARNESSES = Object.freeze(
    Object.entries(catalog.harnesses || {}).reduce((acc, [id, harness]) => {
      acc[id] = freezeHarness(harness);
      return acc;
    }, {}),
);

const RUNNER_IMAGES = Object.freeze(
    catalog.images.reduce((acc, image) => {
      acc[image.imageKey] = freezeResolvedImage(image);
      return acc;
    }, {}),
);

const RUNNER_IMAGES_BY_IMAGE = Object.freeze(
    Object.values(RUNNER_IMAGES).reduce((acc, image) => {
      acc[image.image] = image;
      return acc;
    }, {}),
);

function freezeResolvedImage(image) {
  return Object.freeze({
    key: image.imageKey,
    imageKey: image.imageKey,
    harnessId: image.harnessId,
    label: image.label,
    variant: image.variant,
    image: image.image,
    terminalKind: resolveHarness(image.harnessId).terminalKind,
    capabilities: cloneCapabilities(image.capabilities),
  });
}

function freezeHarness(harness) {
  return Object.freeze({
    ...harness,
    auth: Object.freeze(harness.auth || {supported: false}),
    skills: Object.freeze(harness.skills || {supported: false}),
    mcp: Object.freeze(harness.mcp || {supported: false}),
    subagents: Object.freeze(harness.subagents || {supported: false}),
    packages: Object.freeze(harness.packages || {supported: false}),
  });
}

function cloneCapabilities(capabilities) {
  return {
    terminal: Boolean(capabilities && capabilities.terminal),
    preview: Boolean(capabilities && capabilities.preview),
    previewQa: Boolean(capabilities && capabilities.previewQa),
    functions: Boolean(capabilities && capabilities.functions),
    n64: Boolean(capabilities && capabilities.n64),
  };
}

function listRunnerImages() {
  return catalog.images.map((image) => ({
    ...image,
    capabilities: cloneCapabilities(image.capabilities),
  }));
}

function resolveHarness(harnessId) {
  return HARNESSES[cleanRunnerImageValue(harnessId)] || null;
}

function resolveSessionHarness(session = {}) {
  const explicitHarness = resolveHarness(session.harnessId);
  if (explicitHarness) return explicitHarness;

  const terminalKind = cleanRunnerImageValue(session.terminalKind);
  const terminalMatch = Object.values(HARNESSES).find((harness) => harness.terminalKind === terminalKind);
  if (terminalMatch) return terminalMatch;

  const imageMatch = RUNNER_IMAGES_BY_IMAGE[cleanRunnerImageValue(session.image)];
  if (imageMatch) return resolveHarness(imageMatch.harnessId);

  const keyMatch = RUNNER_IMAGES[cleanRunnerImageValue(session.imageKey)];
  if (keyMatch) return resolveHarness(keyMatch.harnessId);

  return resolveHarness("shell");
}

function runnerImageCapabilities(image) {
  const runnerImage = RUNNER_IMAGES_BY_IMAGE[cleanRunnerImageValue(image)];
  return runnerImage ? cloneCapabilities(runnerImage.capabilities) : cloneCapabilities({terminal: true});
}

function currentRunnerImageForKey(imageKey) {
  const runnerImage = RUNNER_IMAGES[cleanRunnerImageValue(imageKey)];
  return runnerImage ? resolvedRunnerImage(runnerImage) : null;
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
      imageKey: "",
      image: "",
      harnessId: "shell",
      terminalKind: "shell",
      capabilities: cloneCapabilities({terminal: true}),
      canProvision: false,
    };
  }

  const runnerImage = RUNNER_IMAGES_BY_IMAGE[configuredDefaultImage];
  if (runnerImage) return resolvedRunnerImage(runnerImage);

  return {
    key: "configured-default",
    imageKey: "configured-default",
    image: configuredDefaultImage,
    harnessId: "shell",
    terminalKind: "shell",
    capabilities: cloneCapabilities({terminal: true}),
    canProvision: true,
  };
}

function resolvedRunnerImage(runnerImage) {
  return {
    key: runnerImage.key,
    imageKey: runnerImage.imageKey,
    image: runnerImage.image,
    harnessId: runnerImage.harnessId,
    terminalKind: runnerImage.terminalKind || "shell",
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
  HARNESSES,
  RUNNER_IMAGES,
  cloneCapabilities,
  currentRunnerImageForKey,
  listRunnerImages,
  resolveHarness,
  resolveRunnerImage,
  resolveSessionHarness,
  runnerImageCapabilities,
};
