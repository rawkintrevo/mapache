"use strict";

const {createPiPackageService} = require("./piPackage.service");
const {createPiSeededSkillService} = require("./piSeededSkills.service");
const {createPiSkillService} = require("./piSkill.service");
const {defaultWorkspaceSkills} = require("./workspaceSkillCatalog");

function createPiService({config, syncUp}) {
  let packageOperationLock = null;
  let skillOperationLock = null;
  const packageService = createPiPackageService({config, syncUp});
  const skillService = createPiSkillService({config, syncUp});
  const seededSkillService = createPiSeededSkillService({config, defaultRuntimeSkills});

  async function withPackageOperationLock(options, operation) {
    while (packageOperationLock) {
      if (!options || !options.read) {
        const busyError = new Error("package_operation_busy");
        busyError.code = "package_operation_busy";
        throw busyError;
      }
      await packageOperationLock.catch(() => {});
    }

    let releaseLock;
    const currentLock = new Promise((resolve) => {
      releaseLock = resolve;
    });
    packageOperationLock = currentLock;
    try {
      return await operation();
    } finally {
      releaseLock();
      if (packageOperationLock === currentLock) {
        packageOperationLock = null;
      }
    }
  }

  async function withSkillOperationLock(options, operation) {
    while (skillOperationLock) {
      if (!options || !options.read) {
        const busyError = new Error("skill_operation_busy");
        busyError.code = "skill_operation_busy";
        throw busyError;
      }
      await skillOperationLock.catch(() => {});
    }

    let releaseLock;
    const currentLock = new Promise((resolve) => {
      releaseLock = resolve;
    });
    skillOperationLock = currentLock;
    try {
      return await operation();
    } finally {
      releaseLock();
      if (skillOperationLock === currentLock) {
        skillOperationLock = null;
      }
    }
  }

  return {
    ...packageService,
    ...skillService,
    ...seededSkillService,
    withPackageOperationLock,
    withSkillOperationLock,
  };
}

function sendPiPackageError(res, error, fallbackCode) {
  if (error && error.code === "package_operation_busy") {
    res.status(409).json({error: "package_operation_busy", busy: true});
    return;
  }
  if (error && error.code === "invalid_package_source") {
    res.status(400).json({error: "invalid_package_source"});
    return;
  }
  if (error && error.code === "unsupported_package_source") {
    res.status(400).json({error: "unsupported_package_source"});
    return;
  }
  console.error(`${fallbackCode.replace(/_/g, " ")}`, error);
  res.status(500).json({error: fallbackCode});
}

function sendPiSkillError(res, error, fallbackCode) {
  if (error && error.code === "skill_operation_busy") {
    res.status(409).json({error: "skill_operation_busy", busy: true});
    return;
  }
  if (error && [
    "invalid_skill_name",
    "invalid_skill_description",
    "invalid_skill_content",
    "skill_not_found",
  ].includes(error.code)) {
    res.status(error.code === "skill_not_found" ? 404 : 400).json({error: error.code});
    return;
  }
  console.error(`${fallbackCode.replace(/_/g, " ")}`, error);
  res.status(500).json({error: fallbackCode});
}

function defaultRuntimeSkills(config = {}) {
  return defaultWorkspaceSkills(config);
}

module.exports = {
  createPiService,
  defaultRuntimeSkills,
  sendPiPackageError,
  sendPiSkillError,
};
