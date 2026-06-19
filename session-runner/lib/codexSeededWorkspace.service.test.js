"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {defaultWorkspaceSeeds} = require("./codex");
const {createCodexSeededWorkspaceService, resolveSeedContent} = require("./codexSeededWorkspace.service");

test("seeds default codex workspace files without overwriting existing files", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-codex-seeds-"));
  t.after(() => fs.rm(workspaceDir, {recursive: true, force: true}));

  const existingAgentsPath = path.join(workspaceDir, "AGENTS.md");
  await fs.writeFile(existingAgentsPath, "user guidance", "utf8");

  const service = createCodexSeededWorkspaceService({
    config: {
      workspaceDir,
      workspaceSourceMode: "blank",
      runnerCapabilities: {},
    },
    defaultWorkspaceSeeds() {
      return [
        {name: "agents", targetPath: "AGENTS.md", content: "seeded guidance"},
        {name: "preview", targetPath: path.join(".agents", "skills", "preview", "SKILL.md"), content: "seeded skill"},
      ];
    },
  });

  await service.seedDefaultWorkspaceFiles();

  assert.equal(await fs.readFile(existingAgentsPath, "utf8"), "user guidance");
  assert.equal(
      await fs.readFile(path.join(workspaceDir, ".agents", "skills", "preview", "SKILL.md"), "utf8"),
      "seeded skill",
  );
});

test("default codex workspace seed catalog selects blank, github, and preview seeds", async () => {
  assert.deepEqual(defaultWorkspaceSeeds({
    workspaceSourceMode: "blank",
    runnerCapabilities: {},
  }).map((seed) => seed.targetPath), [
    "AGENTS.md",
  ]);

  assert.deepEqual(defaultWorkspaceSeeds({
    workspaceSourceMode: "github",
    runnerCapabilities: {},
  }).map((seed) => seed.targetPath), [
    path.join(".agents", "skills", "mapache-github-issue", "SKILL.md"),
  ]);

  const previewSeeds = defaultWorkspaceSeeds({
    workspaceSourceMode: "github",
    runnerCapabilities: {preview: true},
  });
  assert.deepEqual(previewSeeds.map((seed) => seed.targetPath), [
    path.join(".agents", "skills", "mapache-github-issue", "SKILL.md"),
    path.join(".agents", "skills", "mapache-preview-build", "SKILL.md"),
    path.join(".agents", "skills", "mapache-api-hosting", "SKILL.md"),
    path.join(".agents", "skills", "mapache-preview-qa", "SKILL.md"),
  ]);

  const contents = await Promise.all(previewSeeds.map(resolveSeedContent));
  assert.ok(contents.every((content) => content.length > 0));
});
