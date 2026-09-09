"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {createPiPackageService} = require("./piPackage.service");

test("approves Pi package removal before changing local package config", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-pi-package-service-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const calls = [];
  const service = createPiPackageService({
    config: {workspaceDir: root, piAgentDir: path.join(root, ".pi", "agent")},
    runPiCommand: async (args) => calls.push(args),
    syncUp: async () => {},
  });

  await service.removeWorkspacePiPackage({source: "npm:pi-mcp-adapter"});

  assert.deepEqual(calls, [["remove", "--approve", "-l", "npm:pi-mcp-adapter"]]);
});
