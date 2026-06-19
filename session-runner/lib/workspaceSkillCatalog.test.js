"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  WORKSPACE_SKILL_PROFILES,
  defaultWorkspaceSkillProfileIds,
  defaultWorkspaceSkills,
  skillsForWorkspaceProfiles,
} = require("./workspaceSkillCatalog");

test("selects harness-neutral skill profiles from workspace context and capabilities", () => {
  assert.deepEqual(defaultWorkspaceSkillProfileIds({
    workspaceSourceMode: "blank",
    runnerCapabilities: {},
  }), []);
  assert.deepEqual(defaultWorkspaceSkillProfileIds({
    workspaceSourceMode: "github",
    runnerCapabilities: {preview: true},
  }), ["github", "web"]);
  assert.deepEqual(defaultWorkspaceSkillProfileIds({
    workspaceSourceMode: "github",
    runnerCapabilities: {preview: true, n64: true},
  }), ["github", "n64"]);
});

test("resolves optional profiles into one canonical file-backed skill catalog", () => {
  assert.deepEqual(Object.keys(WORKSPACE_SKILL_PROFILES), ["github", "n64", "web"]);
  assert.deepEqual(skillsForWorkspaceProfiles(["web", "github", "web", "unknown"])
      .map((skill) => skill.name), [
    "mapache-preview-build",
    "mapache-api-hosting",
    "mapache-preview-qa",
    "mapache-github-issue",
  ]);

  const skills = defaultWorkspaceSkills({
    workspaceSourceMode: "blank",
    runnerCapabilities: {preview: true},
  });
  assert.ok(skills.every((skill) => skill.filePath.endsWith(
      path.join("seeded-skills", skill.name, "SKILL.md"),
  )));
});
