"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {defaultRuntimeSkills} = require("./pi");
const {createPiSeededSkillService, resolveSeededSkillContent} = require("./piSeededSkills.service");

test("seeds default runtime skills without overwriting existing files", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-pi-skills-"));
  t.after(() => fs.rm(workspaceDir, {recursive: true, force: true}));

  const existingSkillPath = path.join(workspaceDir, ".pi", "skills", "existing-skill", "SKILL.md");
  await fs.mkdir(path.dirname(existingSkillPath), {recursive: true});
  await fs.writeFile(existingSkillPath, "user content", "utf8");

  const service = createPiSeededSkillService({
    config: {
      workspaceDir,
      runnerCapabilities: {preview: true},
    },
    defaultRuntimeSkills(capabilities) {
      assert.deepEqual(capabilities.runnerCapabilities, {preview: true});
      return [
        {name: "existing-skill", content: "seeded replacement"},
        {name: "new-skill", content: "seeded content"},
      ];
    },
  });

  await service.seedDefaultRuntimeSkills();

  assert.equal(await fs.readFile(existingSkillPath, "utf8"), "user content");
  assert.equal(
      await fs.readFile(path.join(workspaceDir, ".pi", "skills", "new-skill", "SKILL.md"), "utf8"),
      "seeded content",
  );
});

test("skips missing file-backed seeded skills without failing startup", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-pi-missing-skills-"));
  t.after(() => fs.rm(workspaceDir, {recursive: true, force: true}));

  const service = createPiSeededSkillService({
    config: {
      workspaceDir,
      runnerCapabilities: {},
      workspaceSourceMode: "github",
    },
    defaultRuntimeSkills() {
      return [
        {
          name: "missing-skill",
          filePath: path.join(workspaceDir, "does-not-exist", "SKILL.md"),
        },
      ];
    },
  });

  await service.seedDefaultRuntimeSkills();

  const missingSkillPath = path.join(workspaceDir, ".pi", "skills", "missing-skill", "SKILL.md");
  await assert.rejects(fs.stat(missingSkillPath), {code: "ENOENT"});
});

test("seeds default runtime skills from Markdown files", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-pi-file-skills-"));
  t.after(() => fs.rm(workspaceDir, {recursive: true, force: true}));

  const service = createPiSeededSkillService({
    config: {
      workspaceDir,
      runnerCapabilities: {preview: true},
      workspaceSourceMode: "blank",
    },
    defaultRuntimeSkills,
  });

  await service.seedDefaultRuntimeSkills();

  const previewSkillPath = path.join(
      workspaceDir,
      ".pi",
      "skills",
      "mapache-preview-build",
      "SKILL.md",
  );
  const previewSkill = await fs.readFile(previewSkillPath, "utf8");
  assert.match(previewSkill, /^---\nname: mapache-preview-build\n/m);
  assert.match(previewSkill, /http:\/\/localhost:<port>\//);
  assert.match(previewSkill, /chrome-devtools/);
  assert.doesNotMatch(previewSkill, /\$MAPACHE_PREVIEW_URL/);
});

test("default runtime skill catalog selects common and preview file-backed seeds", async () => {
  assert.deepEqual(defaultRuntimeSkills({runnerCapabilities: {}, workspaceSourceMode: "blank"}), []);

  const commonSkills = defaultRuntimeSkills({runnerCapabilities: {}, workspaceSourceMode: "github"});
  assert.deepEqual(commonSkills.map((skill) => skill.name), ["mapache-github-issue"]);
  assert.ok(commonSkills.every((skill) => skill.filePath.endsWith(path.join(skill.name, "SKILL.md"))));

  assert.deepEqual(defaultRuntimeSkills({
    runnerCapabilities: {preview: true},
    workspaceSourceMode: "blank",
  }).map((skill) => skill.name), [
    "mapache-preview-build",
    "mapache-api-hosting",
    "mapache-preview-qa",
  ]);
  assert.deepEqual(defaultRuntimeSkills({
    runnerCapabilities: {preview: true},
    workspaceSourceMode: "github",
  }).map((skill) => skill.name), [
    "mapache-github-issue",
    "mapache-preview-build",
    "mapache-api-hosting",
    "mapache-preview-qa",
  ]);
  const contents = await Promise.all(defaultRuntimeSkills({
    runnerCapabilities: {preview: true},
    workspaceSourceMode: "github",
  }).map(resolveSeededSkillContent));
  assert.ok(contents.every((content) => content.startsWith("---\nname: ")));
});

for (const runtimeKind of ["main", "automation"]) {
  test(`seeds workspace request discovery for ${runtimeKind} without replacing existing guidance`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-request-skills-"));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    const config = {
      workspaceDir: root,
      piAgentDir: path.join(root, "private-agent"),
      agentRuntimeEnabled: true,
      runtimeKind,
      ...(runtimeKind === "automation" ? {automationOutputDir: path.join(root, "output")} : {}),
    };
    const skillsDir = runtimeKind === "automation" ? path.join(config.piAgentDir, "skills") : path.join(root, ".pi", "skills");
    const oldSkill = path.join(skillsDir, "mapache-automations", "SKILL.md");
    await fs.mkdir(path.dirname(oldSkill), {recursive: true});
    await fs.writeFile(oldSkill, "User-edited scheduling guidance");
    const service = createPiSeededSkillService({config, defaultRuntimeSkills});
    await service.seedDefaultRuntimeSkills();
    const requestPath = path.join(skillsDir, "mapache-workspace-requests", "SKILL.md");
    assert.match(await fs.readFile(requestPath, "utf8"), /description: Get information/);
    assert.equal(await fs.readFile(oldSkill, "utf8"), "User-edited scheduling guidance");
    await fs.writeFile(requestPath, "User-edited request guidance");
    await service.seedDefaultRuntimeSkills();
    assert.equal(await fs.readFile(requestPath, "utf8"), "User-edited request guidance");
  });
}
