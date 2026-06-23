"use strict";

const assert = require("assert");
const test = require("node:test");
const {createPiService} = require("./pi");

test("shell harness defers unsupported skill and subagent services until route use", async () => {
  const service = createPiService({
    config: {
      harnessId: "shell",
      terminalKind: "shell",
      workspaceDir: "/workspace",
    },
    syncUp: async () => {},
  });

  await assert.rejects(
      () => service.listWorkspaceSkills(),
      (error) => error && error.code === "runner_skill_listing_unsupported",
  );
  await assert.rejects(
      () => service.listWorkspaceSubagents(),
      (error) => error && error.code === "runner_subagent_listing_unsupported",
  );
});
