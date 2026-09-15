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
  const expected = `${config.githubRepoOwner}/${config.githubRepoName}`.toLowerCase();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--repo" || args[index] === "-R") {
      if (String(args[index + 1] || "").toLowerCase() !== expected) throw new Error("github_repository_not_allowed");
    }
  }
  const apiIndex = args.indexOf("api");
  if (apiIndex >= 0 && args[apiIndex + 1] && /^repos\//i.test(args[apiIndex + 1]) &&
      String(args[apiIndex + 1]).split("/").slice(0, 3).slice(1).join("/").toLowerCase() !== expected) {
    throw new Error("github_repository_not_allowed");
  }
}

main().catch((error) => {
  console.error(String(error?.message || "github_cli_failed").replace(/[\r\n]/g, " "));
  process.exitCode = 1;
});
