"use strict";

const {runCommand} = require("./processes");

function createGitCommandRunner({config}) {
  return async function runGitCommand(args, options = {}) {
    return runCommand("git", args, {
      captureStdout: options.captureStdout,
      cwd: options.cwd || config.workspaceDir,
      env: options.env || process.env,
    });
  };
}

module.exports = {
  createGitCommandRunner,
};
