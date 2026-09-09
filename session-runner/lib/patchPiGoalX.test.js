"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {patchPiGoalX} = require("./patchPiGoalX");

test("patches the task confirmation dialog with an RPC confirm branch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-pi-goal-patch-"));
  const target = path.join(root, "npm", "node_modules", "pi-goal-x", "extensions");
  await fs.mkdir(target, {recursive: true});
  const file = path.join(target, "goal-task-confirmation.ts");
  await fs.writeFile(file, "export async function showTaskConfirmation(ctx: ExtensionContext, proposalText: string) {\n\tconst autoConfirmEnv = process.env.PI_GOAL_AUTO_CONFIRM;\n}");
  const result = patchPiGoalX({agentDir: root});
  assert.equal(result.patched, true);
  const source = await fs.readFile(file, "utf8");
  assert.match(source, /ctx\.mode === "rpc"/);
  assert.equal(patchPiGoalX({agentDir: root}).reason, "already_patched");
});

test("does not fail when the baked package is absent", () => {
  const result = patchPiGoalX({agentDir: "/tmp/mapache-pi-goal-package-does-not-exist"});
  assert.equal(result.reason, "managed_package_missing");
});
