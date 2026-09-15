"use strict";

const readline = require("readline");
const {createConfig} = require("../lib/config");
const {createGithubTokenProvider} = require("../lib/githubTokenProvider.service");

async function main() {
  const config = createConfig();
  const lines = [];
  for await (const line of readline.createInterface({input: process.stdin})) lines.push(line);
  const values = Object.fromEntries(lines.map((line) => line.split("=", 2)).filter(([key]) => key));
  const host = String(values.host || "").toLowerCase();
  const path = String(values.path || "").replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  const expected = `${config.githubRepoOwner}/${config.githubRepoName}`.toLowerCase();
  if (host !== "github.com" || path !== expected) return;
  const token = await createGithubTokenProvider({config}).getToken();
  process.stdout.write(`protocol=https\nhost=github.com\nusername=${config.githubAutomationUsername || "x-access-token"}\npassword=${token}\n\n`);
}

main().catch((error) => {
  console.error(String(error?.message || "github_credential_failed").replace(/[\r\n]/g, " "));
  process.exitCode = 1;
});
