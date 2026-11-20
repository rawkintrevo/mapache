"use strict";

const {
  RUNNER_IMAGES,
  canonicalRunnerImageReference,
  isSupportedProvisioningSession,
  resolveRunnerImage,
  resolveSessionCapabilities,
  runnerImageCapabilities,
  resolveSessionRunnerImage,
} = require("./runnerCatalog.helpers");

module.exports = {
  RUNNER_IMAGES,
  canonicalRunnerImageReference,
  isSupportedProvisioningSession,
  resolveRunnerImage,
  resolveSessionCapabilities,
  runnerImageCapabilities,
  resolveSessionRunnerImage,
};
