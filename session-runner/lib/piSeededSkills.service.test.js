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
      assert.deepEqual(capabilities, {preview: true});
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

test("seeds default runtime skills from Markdown files", async (t) => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-pi-file-skills-"));
  t.after(() => fs.rm(workspaceDir, {recursive: true, force: true}));

  const service = createPiSeededSkillService({
    config: {
      workspaceDir,
      runnerCapabilities: {preview: true},
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
  assert.match(previewSkill, /\/workspace\/build\/index\.html/);
});

test("default runtime skill catalog selects common, preview, and n64 file-backed seeds", async () => {
  const commonSkills = defaultRuntimeSkills({});
  assert.deepEqual(commonSkills.map((skill) => skill.name), ["mapache-github-issue"]);
  assert.ok(commonSkills.every((skill) => skill.filePath.endsWith(path.join(skill.name, "SKILL.md"))));

  assert.deepEqual(defaultRuntimeSkills({preview: true}).map((skill) => skill.name), [
    "mapache-github-issue",
    "mapache-preview-build",
    "mapache-api-hosting",
    "mapache-preview-qa",
  ]);
  assert.deepEqual(defaultRuntimeSkills({n64: true}).map((skill) => skill.name), [
    "mapache-github-issue",
    "mapache-n64-build",
    "mapache-n64-preview",
  ]);

  const contents = await Promise.all(defaultRuntimeSkills({n64: true}).map(resolveSeededSkillContent));
  assert.ok(contents.every((content) => content.startsWith("---\nname: ")));
});
