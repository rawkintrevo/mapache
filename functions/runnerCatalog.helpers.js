"use strict";

const catalog = require("./runnerCatalog.json");
const {AGENT_IMAGE_KEY} = require("./agentRuntime.helpers");

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
      for (const legacyImage of image.legacyImages || []) acc[legacyImage] = image;
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
    legacyImageKeys: Object.freeze([...(image.legacyImageKeys || [])]),
    legacyImages: Object.freeze([...(image.legacyImages || [])]),
    terminalKind: resolveHarness(image.harnessId).terminalKind,
    capabilities: cloneCapabilities(image.capabilities),
  });
}

function freezeHarness(harness) {
  return Object.freeze({
    ...harness,
    auth: Object.freeze(harness.auth || {supported: false}),
    mcp: Object.freeze(harness.mcp || {supported: false}),
  });
}

function cloneCapabilities(capabilities) {
  const result = {
    terminal: Boolean(capabilities && capabilities.terminal),
    preview: Boolean(capabilities && capabilities.preview),
    previewQa: Boolean(capabilities && capabilities.previewQa),
    functions: Boolean(capabilities && capabilities.functions),
    chrome: Boolean(capabilities && capabilities.chrome),
  };
  return result;
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

  const keyMatch = runnerImageForKey(session.imageKey);
  if (keyMatch) return resolveHarness(keyMatch.harnessId);

  return resolveHarness("pi");
}

function runnerImageCapabilities(image) {
  const normalizedImage = cleanRunnerImageValue(image);
  const runnerImage = RUNNER_IMAGES_BY_IMAGE[normalizedImage] || runnerImageForKey(normalizedImage);
  return runnerImage ? cloneCapabilities(runnerImage.capabilities) : cloneCapabilities({});
}

function resolveSessionCapabilities(session = {}) {
  const persistedCapabilities = session.capabilities && typeof session.capabilities === "object" ? session.capabilities : {};
  const imageValue = session.imageKey || session.image;
  const normalizedImage = cleanRunnerImageValue(imageValue);
  const knownImage = RUNNER_IMAGES_BY_IMAGE[normalizedImage] || runnerImageForKey(normalizedImage);

  if (!knownImage) {
    return Object.keys(persistedCapabilities).length ? {...persistedCapabilities} : runnerImageCapabilities(imageValue);
  }

  const capabilities = runnerImageCapabilities(imageValue);
  return capabilities;
}

function resolveRunnerImage(payload = {}, defaultImage = "") {
  const requestedKey = cleanRunnerImageValue(payload.imageKey);
  if (requestedKey) {
    const runnerImage = runnerImageForKey(requestedKey);
    if (!runnerImage) throw invalidRunnerImageError();
    return resolvedRunnerImage(runnerImage);
  }

  const legacyImage = cleanRunnerImageValue(payload.image);
  if (legacyImage) {
    const runnerImage = RUNNER_IMAGES_BY_IMAGE[legacyImage];
    if (!runnerImage) throw invalidRunnerImageError();
    return resolvedRunnerImage(runnerImage);
  }

  const configuredDefaultImage = cleanRunnerImageValue(defaultImage);
  const runnerImage = RUNNER_IMAGES_BY_IMAGE[configuredDefaultImage] || runnerImageForKey(configuredDefaultImage);
  if (runnerImage) return resolvedRunnerImage(runnerImage);
  throw invalidRunnerImageError();
}

/**
 * Historical session documents may retain the pi-chrome key and tag. Resolve
 * those values to the canonical gcp-runner image before provisioning.
 */
function isSupportedProvisioningSession(session = {}) {
  const runnerImage = resolveSessionRunnerImage(session);
  if (!runnerImage || runnerImage.key !== AGENT_IMAGE_KEY) return false;
  if (!cleanRunnerImageValue(session.imageKey) || !cleanRunnerImageValue(session.image)) return false;
  if (cleanRunnerImageValue(session.harnessId) && cleanRunnerImageValue(session.harnessId) !== "pi") return false;
  if (cleanRunnerImageValue(session.terminalKind) && cleanRunnerImageValue(session.terminalKind) !== "pi") return false;
  return true;
}

function resolveSessionRunnerImage(session = {}) {
  const imageKey = cleanRunnerImageValue(session.imageKey);
  const imageReference = cleanRunnerImageValue(session.image);
  const keyImage = imageKey ? runnerImageForKey(imageKey) : null;
  const referenceImage = imageReference ? RUNNER_IMAGES_BY_IMAGE[imageReference] : null;
  if (imageKey && !keyImage || imageReference && !referenceImage) return null;
  if (keyImage && referenceImage && keyImage.key !== referenceImage.key) return null;
  return keyImage || referenceImage;
}

function canonicalRunnerImageReference(session = {}) {
  return resolveSessionRunnerImage(session)?.image || "";
}

function runnerImageForKey(value) {
  const normalized = cleanRunnerImageValue(value);
  if (RUNNER_IMAGES[normalized]) return RUNNER_IMAGES[normalized];
  return Object.values(RUNNER_IMAGES).find((image) => image.legacyImageKeys?.includes(normalized)) || null;
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
  HARNESSES,
  RUNNER_IMAGES,
  cloneCapabilities,
  canonicalRunnerImageReference,
  isSupportedProvisioningSession,
  listRunnerImages,
  resolveHarness,
  resolveRunnerImage,
  resolveSessionRunnerImage,
  resolveSessionCapabilities,
  resolveSessionHarness,
  runnerImageCapabilities,
};
