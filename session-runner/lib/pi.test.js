"use strict";

const assert = require("assert");
const test = require("node:test");
const {createPiService} = require("./pi");

test("Pi service exposes only startup-owned seeded skill materialization", async () => {
  const service = createPiService({
    config: {
      harnessId: "shell",
      terminalKind: "shell",
      workspaceDir: "/workspace",
    },
    syncUp: async () => {},
  });

  assert.equal(typeof service.seedDefaultRuntimeSkills, "function");
  for (const name of [
    "listWorkspacePiPackages", "installWorkspacePiPackage", "updateWorkspacePiPackages",
    "listWorkspaceSkills", "saveWorkspaceSkill", "listWorkspaceSubagents", "saveWorkspaceSubagent",
  ]) assert.equal(service[name], undefined, `${name} is retired`);
});
