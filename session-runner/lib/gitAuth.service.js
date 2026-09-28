"use strict";

const fs = require("fs");
const path = require("path");
const {normalizeEnvString} = require("./utils");

const MAPACHE_GIT_CREDENTIAL_HELPER = "!/usr/local/bin/mapache-git-credential";

function createGitAuthService({config, tokenProvider}) {
  async function withGitAskPassAuth({token, username, userEnvName, tokenEnvName, askPassFilePrefix}, task) {
    if (!token) {
      throw new Error("github_auth_not_configured");
    }

    const askPassPath = path.join(process.env.TMPDIR || "/tmp", `${askPassFilePrefix}-${config.sessionId || "runner"}.sh`);
    await fs.promises.writeFile(askPassPath, [
      "#!/bin/sh",
      "case \"$1\" in",
      `  *Username*) printf '%s\\n' \"\${${userEnvName}:-x-access-token}\" ;;`,
      `  *) printf '%s\\n' \"\${${tokenEnvName}:-}\" ;;`,
      "esac",
      "",
    ].join("\n"), {mode: 0o700});

    try {
      return await task({
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: askPassPath,
        [userEnvName]: username || "x-access-token",
        [tokenEnvName]: token,
      });
    } finally {
      await fs.promises.rm(askPassPath, {force: true}).catch(() => {});
    }
  }

  async function configureGithubCredentialHelper(runGitCommand) {
    if (config.workspaceSourceMode !== "github" ||
        !(config.githubAutomationToken || config.githubAutomationTokenRefreshUrl) ||
        !config.githubRepoOwner || !config.githubRepoName) {
      return {configured: false, skipped: true};
    }

    const configuredHelpers = String(await runGitCommand(
        ["config", "--local", "--get-all", "credential.helper"],
        {captureStdout: true},
    ).catch(() => "")).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const helperAdded = !configuredHelpers.includes(MAPACHE_GIT_CREDENTIAL_HELPER);
    if (helperAdded) {
      await runGitCommand(["config", "--local", "--add", "credential.helper", MAPACHE_GIT_CREDENTIAL_HELPER]);
    }

    const useHttpPath = String(await runGitCommand(
        ["config", "--local", "--get", "credential.useHttpPath"],
        {captureStdout: true},
    ).catch(() => "")).trim().toLowerCase();
    const useHttpPathUpdated = useHttpPath !== "true";
    if (useHttpPathUpdated) {
      await runGitCommand(["config", "--local", "credential.useHttpPath", "true"]);
    }

    return {configured: true, helperAdded, useHttpPathUpdated};
  }

  async function withGitCloneAuth(task) {
    return withGitAskPassAuth({
      token: config.githubCloneToken,
      username: config.githubCloneUsername,
      userEnvName: "GITHUB_CLONE_USERNAME",
      tokenEnvName: "GITHUB_CLONE_TOKEN",
      askPassFilePrefix: "mapahce-git-clone-askpass",
    }, task);
  }

  async function withGithubAutomationAuth(task) {
    if (tokenProvider) return tokenProvider.withRetry((token) => withGitAskPassAuth({
      token,
      username: config.githubAutomationUsername,
      userEnvName: "GITHUB_AUTOMATION_USERNAME",
      tokenEnvName: "GITHUB_AUTOMATION_TOKEN",
      askPassFilePrefix: "mapahce-git-automation-askpass",
    }, task));
    return withGitAskPassAuth({
      token: config.githubAutomationToken,
      username: config.githubAutomationUsername,
      userEnvName: "GITHUB_AUTOMATION_USERNAME",
      tokenEnvName: "GITHUB_AUTOMATION_TOKEN",
      askPassFilePrefix: "mapahce-git-automation-askpass",
    }, task);
  }

  async function withGitPushAuth(task) {
    const token = normalizeEnvString(process.env.GITHUB_PUSH_TOKEN);
    return withGitAskPassAuth({
      token,
      username: normalizeEnvString(process.env.GITHUB_PUSH_USERNAME) || "x-access-token",
      userEnvName: "GITHUB_PUSH_USERNAME",
      tokenEnvName: "GITHUB_PUSH_TOKEN",
      askPassFilePrefix: "mapahce-git-push-askpass",
    }, task);
  }

  async function withGitPushPayloadAuth(auth, task) {
    return withGitAskPassAuth({
      token: normalizeEnvString(auth && auth.pushToken),
      username: normalizeEnvString(auth && auth.pushUsername) || "x-access-token",
      userEnvName: "GITHUB_PUSH_USERNAME",
      tokenEnvName: "GITHUB_PUSH_TOKEN",
      askPassFilePrefix: "mapahce-git-push-askpass",
    }, task);
  }

  return {
    configureGithubCredentialHelper,
    withGitAskPassAuth,
    withGitCloneAuth,
    withGithubAutomationAuth,
    withGitPushAuth,
    withGitPushPayloadAuth,
  };
}

module.exports = {
  MAPACHE_GIT_CREDENTIAL_HELPER,
  createGitAuthService,
};
