"use strict";

const {createPiSeededSkillService} = require("./piSeededSkills.service");
const {defaultWorkspaceSkills} = require("./workspaceSkillCatalog");

// Pi is retained as the managed agent process and seeded-skill owner. The
// legacy Mapache package, skill, subagent, model, Git, Goals, and Chat control
// surfaces are intentionally not exposed by the runner.
function createPiService({config, syncUp}) {
  return createPiSeededSkillService({config, defaultRuntimeSkills, syncUp});
}

function defaultRuntimeSkills(config = {}) {
  return defaultWorkspaceSkills(config);
}

module.exports = {
  createPiService,
  defaultRuntimeSkills,
};
