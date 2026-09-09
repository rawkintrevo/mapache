"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {createWorkspaceSkillService} = require("./workspaceSkill.service");

async function writeSkill(root, relativeDirectory, name, description = `${name} description`) {
  const skillPath = path.join(root, relativeDirectory, "SKILL.md");
  await fs.mkdir(path.dirname(skillPath), {recursive: true});
  await fs.writeFile(skillPath, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, "utf8");
  return skillPath;
}

test("Pi inspector discovery includes recursive project and user-local skill roots", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-skill-discovery-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const workspaceDir = path.join(root, "workspace");
  const homeDir = path.join(root, "home");
  const piAgentDir = path.join(homeDir, ".pi", "agent");

  await writeSkill(path.join(workspaceDir, ".pi", "skills"), "native", "native-skill");
  await writeSkill(path.join(workspaceDir, ".agents", "skills"), path.join("team", "nested"), "agents-skill");
  await writeSkill(path.join(piAgentDir, "skills"), "personal", "personal-skill");
  await writeSkill(path.join(homeDir, ".agents", "skills"), "shared", "shared-skill");
  const linkedRoot = path.join(root, "linked-skill");
  await writeSkill(linkedRoot, ".", "linked-skill");
  await fs.mkdir(path.join(piAgentDir, "skills"), {recursive: true});
  await fs.symlink(linkedRoot, path.join(piAgentDir, "skills", "linked-skill"), "dir");
  await writeSkill(path.join(workspaceDir, ".pi", "skills", "native"), "nested", "ignored-nested-skill");

  const service = createWorkspaceSkillService({
    config: {harnessId: "pi", homeDir, piAgentDir, workspaceDir},
    syncUp: async () => {},
  });
  const result = await service.listWorkspaceSkills();

  assert.deepEqual(result.skills.map((skill) => skill.name), [
    "agents-skill",
    "linked-skill",
    "native-skill",
    "personal-skill",
    "shared-skill",
  ]);
  assert.equal(result.skills.find((skill) => skill.name === "native-skill").editable, true);
  assert.equal(result.skills.find((skill) => skill.name === "agents-skill").editable, false);
  assert.equal(result.skills.find((skill) => skill.name === "personal-skill").scope, "user");
  assert.equal(result.skills.find((skill) => skill.name === "agents-skill").path, ".agents/skills/team/nested/SKILL.md");
  assert.ok(result.skills.every((skill) => skill.discovered));
});

test("Codex inspector discovery recursively scans CODEX_HOME and favors editable workspace names", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-codex-skill-discovery-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const workspaceDir = path.join(root, "workspace");
  const homeDir = path.join(root, "home");
  const codexHomeDir = path.join(root, "codex-home");

  await writeSkill(path.join(workspaceDir, ".agents", "skills"), "workspace-copy", "duplicate", "workspace winner");
  await writeSkill(path.join(codexHomeDir, "skills"), path.join(".system", "local"), "duplicate", "user loser");
  await writeSkill(path.join(codexHomeDir, "skills"), path.join("installed", "nested"), "installed-skill");

  const service = createWorkspaceSkillService({
    config: {codexHomeDir, harnessId: "codex", homeDir, workspaceDir},
    syncUp: async () => {},
  });
  const result = await service.listWorkspaceSkills();

  assert.deepEqual(result.skills.map((skill) => skill.name), ["duplicate", "installed-skill"]);
  assert.equal(result.skills.find((skill) => skill.name === "duplicate").description, "workspace winner");
  assert.equal(result.skills.find((skill) => skill.name === "duplicate").editable, true);
  assert.equal(result.skills.find((skill) => skill.name === "installed-skill").path, "$CODEX_HOME/skills/installed/nested/SKILL.md");
});
