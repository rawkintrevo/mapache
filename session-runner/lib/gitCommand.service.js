"use strict";

const {runCommand} = require("./processes");

function createGitCommandRunner({config}) {
  return async function runGitCommand(args, options = {}) {
    const env = {
      ...(options.env || process.env),
    };
    if (config.workspaceStorageMode === "shared-gcsfuse-v1") {
      env.GIT_DIR = config.privateGitDir;
      env.GIT_WORK_TREE = config.workspaceDir;
    }
    return runCommand("git", args, {
      captureStdout: options.captureStdout,
      cwd: options.cwd || config.workspaceDir,
      env,
    });
  };
}

module.exports = {
  createGitCommandRunner,
};
