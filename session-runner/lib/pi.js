"use strict";

const {resolveHarnessMetadata} = require("./harnesses/metadata");
const {createPiPackageService} = require("./piPackage.service");
const {createPiSeededSkillService} = require("./piSeededSkills.service");
const {createWorkspaceSkillService} = require("./workspaceSkill.service");
const {createWorkspaceSubagentService} = require("./workspaceSubagent.service");
const {defaultWorkspaceSkills} = require("./workspaceSkillCatalog");

function createPiService({config, syncUp}) {
  let packageOperationLock = null;
  let skillOperationLock = null;
  let subagentOperationLock = null;
  let skillService = null;
  let subagentService = null;
  const harness = resolveHarnessMetadata(config);
  const packageService = createPiPackageService({config, syncUp});
  const seededSkillService = createPiSeededSkillService({config, defaultRuntimeSkills});

  function requireSkillService(errorCode) {
    if (!harness.skills?.supported) {
      const error = new Error(errorCode);
      error.code = errorCode;
      throw error;
    }
    if (!skillService) skillService = createWorkspaceSkillService({config, syncUp});
    return skillService;
  }

  function requireSubagentService(errorCode) {
    if (!harness.subagents?.supported) {
      const error = new Error(errorCode);
      error.code = errorCode;
      throw error;
    }
    if (!subagentService) subagentService = createWorkspaceSubagentService({config, syncUp});
    return subagentService;
  }

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

  async function withSubagentOperationLock(options, operation) {
    while (subagentOperationLock) {
      if (!options || !options.read) {
        const busyError = new Error("subagent_operation_busy");
        busyError.code = "subagent_operation_busy";
        throw busyError;
      }
      await subagentOperationLock.catch(() => {});
    }

    let releaseLock;
    const currentLock = new Promise((resolve) => {
      releaseLock = resolve;
    });
    subagentOperationLock = currentLock;
    try {
      return await operation();
    } finally {
      releaseLock();
      if (subagentOperationLock === currentLock) {
        subagentOperationLock = null;
      }
    }
  }

  return {
    ...packageService,
    ...seededSkillService,
    listWorkspaceSkills: async () => requireSkillService("runner_skill_listing_unsupported").listWorkspaceSkills(),
    saveWorkspaceSkill: async (body) => requireSkillService("runner_skill_save_unsupported").saveWorkspaceSkill(body),
    deleteWorkspaceSkill: async (body) => requireSkillService("runner_skill_delete_unsupported").deleteWorkspaceSkill(body),
    listWorkspaceSubagents: async () => requireSubagentService("runner_subagent_listing_unsupported").listWorkspaceSubagents(),
    saveWorkspaceSubagent: async (body) => requireSubagentService("runner_subagent_save_unsupported").saveWorkspaceSubagent(body),
    deleteWorkspaceSubagent: async (body) => requireSubagentService("runner_subagent_delete_unsupported").deleteWorkspaceSubagent(body),
    listWorkspaceSubagentChains: async () => requireSubagentService("runner_subagent_chains_list_unsupported").listWorkspaceSubagentChains(),
    saveWorkspaceSubagentChain: async (body) => requireSubagentService("runner_subagent_chains_save_unsupported").saveWorkspaceSubagentChain(body),
    deleteWorkspaceSubagentChain: async (body) => requireSubagentService("runner_subagent_chains_delete_unsupported").deleteWorkspaceSubagentChain(body),
    withPackageOperationLock,
    withSkillOperationLock,
    withSubagentOperationLock,
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
  if (error && (error.code === "skill_operation_busy" || error.code === "subagent_operation_busy")) {
    res.status(409).json({error: error.code, busy: true});
    return;
  }
  if (error && [
    "invalid_skill_name",
    "invalid_skill_description",
    "invalid_skill_content",
    "skill_not_found",
    "runner_skill_listing_unsupported",
    "runner_skill_save_unsupported",
    "runner_skill_delete_unsupported",
    "runner_subagent_listing_unsupported",
    "runner_subagent_save_unsupported",
    "runner_subagent_delete_unsupported",
    "runner_subagent_chains_list_unsupported",
    "runner_subagent_chains_save_unsupported",
    "runner_subagent_chains_delete_unsupported",
    "invalid_subagent_description",
    "invalid_subagent_content",
    "subagent_not_found",
    "subagent_chains_write_unsupported",
  ].includes(error.code)) {
    res.status([
      "skill_not_found",
      "subagent_not_found",
    ].includes(error.code) ? 404 :
    error.code.includes("_unsupported") ? 501 : 400).json({error: error.code});
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
