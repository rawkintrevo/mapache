"use strict";

const workspaceAuthService = require("./workspaceAuth.service");

module.exports = {
  ...workspaceAuthService,
  createWorkspacePiAuthService: workspaceAuthService.createWorkspaceAuthService,
};
