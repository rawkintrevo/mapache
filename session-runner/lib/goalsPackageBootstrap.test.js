"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {createGoalsPackageBootstrap, isGoalPackageSource} = require("./goalsPackageBootstrap");

test("reconciles the pinned goal package after restoring Pi settings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-goal-package-"));
  const agentDir = path.join(root, ".pi", "agent");
  await fs.mkdir(path.join(agentDir, "npm", "node_modules", "pi-goal-x"), {recursive: true});
  await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: ["npm:pi-goal-x@0.30.5", "npm:pi-mcp-adapter@1.0.0"],
    themes: ["keep-me"],
  }));
  const previous = process.env.GOAL_BRIDGE_ENABLED;
  process.env.GOAL_BRIDGE_ENABLED = "true";
  try {
    const result = await createGoalsPackageBootstrap({config: {harnessId: "pi", piAgentDir: agentDir}}).ensureInstalledDeclaration();
    assert.equal(result.enabled, true);
    assert.equal(result.changed, true);
    const settings = JSON.parse(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"));
    assert.deepEqual(settings.packages, ["npm:pi-mcp-adapter@1.0.0", "npm:pi-goal-x@0.31.2"]);
    assert.deepEqual(settings.themes, ["keep-me"]);
  } finally {
    if (previous === undefined) delete process.env.GOAL_BRIDGE_ENABLED;
    else process.env.GOAL_BRIDGE_ENABLED = previous;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("does not declare the package when the baked files are missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-goal-package-"));
  const previous = process.env.GOAL_BRIDGE_ENABLED;
  process.env.GOAL_BRIDGE_ENABLED = "true";
  try {
    const result = await createGoalsPackageBootstrap({config: {harnessId: "pi", piAgentDir: root}}).ensureInstalledDeclaration();
    assert.equal(result.enabled, false);
    assert.equal(result.reason, "managed_package_missing");
  } finally {
    if (previous === undefined) delete process.env.GOAL_BRIDGE_ENABLED;
    else process.env.GOAL_BRIDGE_ENABLED = previous;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("does not mutate Pi settings on the managed pi-web-ui path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-goal-package-"));
  const agentDir = path.join(root, ".pi", "agent");
  await fs.mkdir(path.join(agentDir, "npm", "node_modules", "pi-goal-x"), {recursive: true});
  const settingsPath = path.join(agentDir, "settings.json");
  await fs.writeFile(settingsPath, JSON.stringify({packages: ["npm:other-package@1.0.0"]}));
  const previous = process.env.GOAL_BRIDGE_ENABLED;
  process.env.GOAL_BRIDGE_ENABLED = "true";
  try {
    const result = await createGoalsPackageBootstrap({
      config: {agentRuntimeEnabled: true, harnessId: "pi", piAgentDir: agentDir},
    }).ensureInstalledDeclaration();
    assert.deepEqual(result, {enabled: false, reason: "agent_runtime_enabled"});
    assert.equal(await fs.readFile(settingsPath, "utf8"), JSON.stringify({packages: ["npm:other-package@1.0.0"]}));
  } finally {
    if (previous === undefined) delete process.env.GOAL_BRIDGE_ENABLED;
    else process.env.GOAL_BRIDGE_ENABLED = previous;
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("recognizes string and object package entries", () => {
  assert.equal(isGoalPackageSource("npm:pi-goal-x@0.31.2"), true);
  assert.equal(isGoalPackageSource({source: "npm:pi-goal-x@0.30.5"}), true);
  assert.equal(isGoalPackageSource("npm:other-package@1.0.0"), false);
});
