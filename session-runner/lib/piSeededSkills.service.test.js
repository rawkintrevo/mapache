"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {createPiSeededSkillService} = require("./piSeededSkills.service");

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
