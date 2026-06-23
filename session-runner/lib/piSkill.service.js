"use strict";

const workspaceSkillService = require("./workspaceSkill.service");

module.exports = {
  ...workspaceSkillService,
  createPiSkillService: workspaceSkillService.createWorkspaceSkillService,
};
