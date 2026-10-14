#!/usr/bin/env node
"use strict";

const {spawn} = require("child_process");
const {createConfig} = require("../lib/config");
const {createGithubTokenProvider} = require("../lib/githubTokenProvider.service");

const MAX_CLI_TOKEN_BYTES = 8192;

async function main() {
  const config = createConfig();
  const args = process.argv.slice(2);
  validateRepositoryArgs(args, config);
  const provider = createGithubTokenProvider({config});
  const token = await getInvocationToken(provider, args, config);
  const child = spawn("gh", process.argv.slice(2), {
    stdio: "inherit",
    env: {...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: "1"},
  });
  child.on("exit", (code, signal) => process.exitCode = signal ? 1 : (code || 0));
}

async function getInvocationToken(provider, args, config) {
  try {
    return await provider.getToken();
  } catch (error) {
    if (error?.message !== "github_token_refresh_unconfigured") throw error;
  }

  try {
    return await getGithubCliToken();
  } catch (error) {
    const fallback = isMapacheIssueOperation(args, config) ?
      "select a GitHub CLI credential in the Mapache Authentication Center or create the issue in your browser at https://github.com/rawkintrevo/mapache/issues/new/choose" :
      "select a GitHub CLI credential in the Mapache Authentication Center";
    throw new Error(`github_cli_auth_unavailable: Mapache token refresh is unconfigured and no GitHub CLI credential is available; ${fallback}`);
  }
}

function getGithubCliToken() {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("gh", ["auth", "token", "--hostname", "github.com"], {
        stdio: ["ignore", "pipe", "ignore"],
        env: {...process.env, GH_PROMPT_DISABLED: "1"},
      });
    } catch (error) {
      reject(new Error("github_cli_auth_unavailable"));
      return;
    }

    const chunks = [];
    let totalBytes = 0;
    let oversized = false;
    child.stdout.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_CLI_TOKEN_BYTES) {
        oversized = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () => reject(new Error("github_cli_auth_unavailable")));
    child.once("close", (code) => {
      if (code !== 0 || oversized) {
        reject(new Error("github_cli_auth_unavailable"));
        return;
      }
      const token = Buffer.concat(chunks).toString("utf8").trim();
      if (!token || token.length > MAX_CLI_TOKEN_BYTES || /\s/.test(token)) {
        reject(new Error("github_cli_auth_unavailable"));
        return;
      }
      resolve(token);
    });
  });
}

function isMapacheIssueOperation(args, config = {}) {
  const apiIndex = args.indexOf("api");
  const apiPath = apiIndex >= 0 ? String(args[apiIndex + 1] || "") : "";
  const isMapacheIssueApi = /^repos\/rawkintrevo\/mapache\/issues(?:\/\d+(?:\/comments)?)?(?:\?|$)/i.test(apiPath);
  const repositoryFlagIndex = args.findIndex((argument) => argument === "--repo" || argument === "-R");
  const currentRepository = `${config.githubRepoOwner || ""}/${config.githubRepoName || ""}`.toLowerCase();
  const selectedRepository = repositoryFlagIndex >= 0 ?
    String(args[repositoryFlagIndex + 1] || "").toLowerCase() : currentRepository;
  const isMapacheIssueCommand = args.some((argument, index) =>
    argument === "issue" && ["create", "list", "view", "status", "close", "reopen", "comment", "edit", "delete"].includes(args[index + 1]),
  );
  return isMapacheIssueApi || (selectedRepository === "rawkintrevo/mapache" && isMapacheIssueCommand);
}

function validateRepositoryArgs(args, config) {
  const workspaceRepository = `${config.githubRepoOwner}/${config.githubRepoName}`.toLowerCase();
  const mapacheRepository = "rawkintrevo/mapache";
  const apiIndex = args.indexOf("api");
  const apiPath = apiIndex >= 0 ? String(args[apiIndex + 1] || "") : "";
  const isMapacheIssueApi = /^repos\/rawkintrevo\/mapache\/issues(?:\/\d+(?:\/comments)?)?(?:\?|$)/i.test(apiPath);
  const isMapacheIssueRequest = isMapacheIssueOperation(args, config);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--repo" || args[index] === "-R") {
      const target = String(args[index + 1] || "").toLowerCase();
      if (target !== workspaceRepository && !(target === mapacheRepository && isMapacheIssueRequest)) {
        throw new Error("github_repository_not_allowed");
      }
    }
  }
  if (apiIndex >= 0 && apiPath && /^repos\//i.test(apiPath)) {
    const target = apiPath.split("/").slice(0, 3).slice(1).join("/").toLowerCase();
    if (target !== workspaceRepository && !(target === mapacheRepository && isMapacheIssueApi)) {
      throw new Error("github_repository_not_allowed");
    }
  }
}

main().catch((error) => {
  console.error(String(error?.message || "github_cli_failed").replace(/[\r\n]/g, " "));
  process.exitCode = 1;
});
