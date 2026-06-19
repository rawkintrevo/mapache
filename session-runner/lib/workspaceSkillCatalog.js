"use strict";

const path = require("path");

const SEEDED_SKILLS_DIR = path.join(__dirname, "..", "seeded-skills");

const WORKSPACE_SKILL_PROFILES = Object.freeze({
  github: Object.freeze([
    "mapache-github-issue",
  ]),
  n64: Object.freeze([
    "mapache-n64-build",
    "mapache-n64-preview",
  ]),
  web: Object.freeze([
    "mapache-preview-build",
    "mapache-api-hosting",
    "mapache-preview-qa",
  ]),
});

function defaultWorkspaceSkillProfileIds(config = {}) {
  const capabilities = config.runnerCapabilities || config;
  const profileIds = [];

  if (config.workspaceSourceMode === "github") profileIds.push("github");
  if (capabilities.n64) profileIds.push("n64");
  else if (capabilities.preview) profileIds.push("web");

  return profileIds;
}

function defaultWorkspaceSkills(config = {}) {
  return skillsForWorkspaceProfiles(defaultWorkspaceSkillProfileIds(config));
}

function skillsForWorkspaceProfiles(profileIds = []) {
  const names = [];
  for (const profileId of profileIds) {
    const profileSkills = WORKSPACE_SKILL_PROFILES[profileId];
    if (!profileSkills) continue;
    for (const name of profileSkills) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names.map(seededWorkspaceSkill);
}

function seededWorkspaceSkill(name) {
  return {
    name,
    filePath: path.join(SEEDED_SKILLS_DIR, name, "SKILL.md"),
  };
}

module.exports = {
  WORKSPACE_SKILL_PROFILES,
  defaultWorkspaceSkillProfileIds,
  defaultWorkspaceSkills,
  seededWorkspaceSkill,
  skillsForWorkspaceProfiles,
};
