"use strict";

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {createPiSkillService, workspaceSkillHarness} = require("./piSkill.service");

test("workspaceSkillHarness resolves Pi and Codex native paths", () => {
  assert.deepStrictEqual(workspaceSkillHarness({
    terminalKind: "pi",
    workspaceDir: "/workspace",
  }), {
    id: "pi",
    label: "Pi",
    relativeSkillsPath: ".pi/skills",
    skillsPath: path.join("/workspace", ".pi", "skills"),
    legacyFileSupport: true,
    restartHint: "Restart Pi in the terminal if a running agent needs to rescan skills.",
  });

  assert.deepStrictEqual(workspaceSkillHarness({
    terminalKind: "codex",
    workspaceDir: "/workspace",
  }), {
    id: "codex",
    label: "Codex",
    relativeSkillsPath: ".agents/skills",
    skillsPath: path.join("/workspace", ".agents", "skills"),
    legacyFileSupport: false,
    restartHint: "Restart Codex in the terminal if a running agent needs to rescan skills.",
  });
});

test("lists, saves, and deletes Pi workspace skills with legacy file compatibility", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-pi-skill-service-"));
  const syncCalls = [];
  const service = createPiSkillService({
    config: {terminalKind: "pi", workspaceDir},
    syncUp: async (options) => syncCalls.push(options),
  });

  await fs.mkdir(path.join(workspaceDir, ".pi", "skills", "directory-skill"), {recursive: true});
  await fs.writeFile(
      path.join(workspaceDir, ".pi", "skills", "directory-skill", "SKILL.md"),
      "---\nname: directory-skill\ndescription: Directory skill\n---\n\nUse the directory skill.\n",
      "utf8",
  );
  await fs.writeFile(
      path.join(workspaceDir, ".pi", "skills", "legacy-file.md"),
      "---\nname: legacy-file\ndescription: Legacy file skill\n---\n\nUse the file skill.\n",
      "utf8",
  );

  const listed = await service.listWorkspaceSkills();
  assert.strictEqual(listed.harness, "pi");
  assert.deepStrictEqual(listed.skills.map((skill) => skill.path), [
    ".pi/skills/directory-skill/SKILL.md",
    ".pi/skills/legacy-file.md",
  ]);

  const saved = await service.saveWorkspaceSkill({
    name: "review-code",
    description: "Review code",
    content: "Check the diff",
  });
  assert.strictEqual(saved.skill.path, ".pi/skills/review-code/SKILL.md");

  await service.deleteWorkspaceSkill({name: "legacy-file"});
  await assert.rejects(
      () => fs.stat(path.join(workspaceDir, ".pi", "skills", "legacy-file.md")),
      /ENOENT/,
  );
  assert.deepStrictEqual(syncCalls, [
    {includeArchives: false},
    {includeArchives: false},
  ]);
});

test("lists, saves, and deletes Codex workspace skills in .agents/skills", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-codex-skill-service-"));
  const service = createPiSkillService({
    config: {terminalKind: "codex", workspaceDir},
    syncUp: async () => {},
  });

  await fs.mkdir(path.join(workspaceDir, ".agents", "skills", "preview-qa"), {recursive: true});
  await fs.writeFile(
      path.join(workspaceDir, ".agents", "skills", "preview-qa", "SKILL.md"),
      "---\nname: preview-qa\ndescription: Preview QA\n---\n\nUse the preview QA skill.\n",
      "utf8",
  );

  const listed = await service.listWorkspaceSkills();
  assert.strictEqual(listed.harness, "codex");
  assert.deepStrictEqual(listed.skills.map((skill) => skill.path), [
    ".agents/skills/preview-qa/SKILL.md",
  ]);

  const saved = await service.saveWorkspaceSkill({
    name: "code-review",
    description: "Review code",
    content: "Check the diff",
  });
  assert.strictEqual(saved.skill.path, ".agents/skills/code-review/SKILL.md");

  const deleted = await service.deleteWorkspaceSkill({name: "code-review"});
  assert.strictEqual(deleted.name, "code-review");
  await assert.rejects(
      () => fs.stat(path.join(workspaceDir, ".agents", "skills", "code-review", "SKILL.md")),
      /ENOENT/,
  );
});
