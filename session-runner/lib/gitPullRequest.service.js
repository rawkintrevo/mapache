"use strict";

const {normalizeEnvString} = require("./utils");
const {normalizeCommitTitle} = require("./gitValidation.helpers");

function githubApiErrorMessage(value) {
  if (!value || typeof value !== "object") return "";
  const message = normalizeEnvString(value.message || "");
  const detail = Array.isArray(value.errors) ? value.errors.map((entry) => {
    if (!entry || typeof entry !== "object") return normalizeEnvString(entry);
    return normalizeEnvString(entry.message || entry.code || entry.field || entry.resource);
  }).filter(Boolean)[0] : "";
  return [message, detail].filter(Boolean).join(": ");
}

function buildAutomationCommitMessage({sessionName}) {
  return `Mapache changes for ${normalizeCommitTitle(sessionName)}`;
}

function buildAutomationPullRequestBody({sessionName, exitCode, baseCommit}) {
  return [
    "## Summary",
    "- Automated changes from a Mapache Pi session.",
    "",
    "## Session",
    `- Session: ${sessionName}`,
    `- Exit code: ${exitCode == null ? "unknown" : exitCode}`,
    baseCommit ? `- Base commit: ${baseCommit}` : "",
  ].filter((line) => line !== "").join("\n");
}

async function createGithubAutomationPullRequest({config, title, body, head, base}) {
  if (!base) {
    throw new Error("github_automation_missing_base_branch");
  }
  const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(config.githubRepoOwner)}/${encodeURIComponent(config.githubRepoName)}/pulls`,
      {
        method: "POST",
        headers: {
          "accept": "application/vnd.github+json",
          "authorization": `Bearer ${config.githubAutomationToken}`,
          "content-type": "application/json",
          "user-agent": "mapahce-session-runner",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({
          title,
          body,
          head,
          base,
          draft: false,
        }),
      },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`github_pull_request_create_failed: ${githubApiErrorMessage(data) || response.status}`);
  }
  return data;
}

module.exports = {
  buildAutomationCommitMessage,
  buildAutomationPullRequestBody,
  createGithubAutomationPullRequest,
  githubApiErrorMessage,
};
