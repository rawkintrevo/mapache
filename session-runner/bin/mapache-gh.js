#!/usr/bin/env node
"use strict";

const {spawn} = require("child_process");
const {createConfig} = require("../lib/config");
const {createGithubTokenProvider} = require("../lib/githubTokenProvider.service");

async function main() {
  const config = createConfig();
  validateRepositoryArgs(process.argv.slice(2), config);
  const provider = createGithubTokenProvider({config});
  const token = await provider.getToken();
  const child = spawn("gh", process.argv.slice(2), {
    stdio: "inherit",
    env: {...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: "1"},
  });
  child.on("exit", (code, signal) => process.exitCode = signal ? 1 : (code || 0));
}

function validateRepositoryArgs(args, config) {
  const workspaceRepository = `${config.githubRepoOwner}/${config.githubRepoName}`.toLowerCase();
  const mapacheRepository = "rawkintrevo/mapache";
  const apiIndex = args.indexOf("api");
  const apiPath = apiIndex >= 0 ? String(args[apiIndex + 1] || "") : "";
  const isMapacheIssueApi = /^repos\/rawkintrevo\/mapache\/issues(?:\/\d+(?:\/comments)?)?(?:\?|$)/i.test(apiPath);
  const isMapacheIssueCommand = args.some((argument, index) =>
    argument === "issue" && ["create", "list", "view", "status", "close", "reopen", "comment", "edit", "delete"].includes(args[index + 1]),
  );
  const isMapacheIssueOperation = isMapacheIssueApi || isMapacheIssueCommand;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--repo" || args[index] === "-R") {
      const target = String(args[index + 1] || "").toLowerCase();
      if (target !== workspaceRepository && !(target === mapacheRepository && isMapacheIssueOperation)) {
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
