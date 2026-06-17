"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildPiSkillMarkdown,
  classifyPiPackageSource,
  normalizePiMutationPackageSource,
  normalizePiPackageSettingsEntry,
  normalizePiSkillContent,
  normalizePiSkillDescription,
  normalizePiSkillName,
  redactPackageSource,
  skillSummaryFromMarkdown,
} = require("./piValidation.helpers");

function assertCode(fn, code) {
  assert.throws(fn, (error) => error && error.code === code);
}

test("normalizes valid package mutation sources", () => {
  assert.equal(normalizePiMutationPackageSource(" npm:@scope/tool@1.2.3 "), "npm:@scope/tool@1.2.3");
  assert.equal(normalizePiMutationPackageSource("github:owner/repo#main"), "github:owner/repo#main");
  assert.equal(normalizePiMutationPackageSource("git+https://github.com/owner/repo.git"), "git+https://github.com/owner/repo.git");
});

test("rejects unsafe or unsupported package mutation sources", () => {
  assertCode(() => normalizePiMutationPackageSource(""), "invalid_package_source");
  assertCode(() => normalizePiMutationPackageSource("npm:bad/package/name"), "invalid_package_source");
  assertCode(() => normalizePiMutationPackageSource("https://token@example.com/owner/repo.git"), "invalid_package_source");
  assertCode(() => normalizePiMutationPackageSource("./local-package"), "unsupported_package_source");
});

test("classifies package sources for installed-path lookup", () => {
  assert.deepEqual(classifyPiPackageSource("npm:@scope/tool@1.2.3"), {
    type: "npm",
    name: "@scope/tool",
  });
  assert.deepEqual(classifyPiPackageSource("git@github.com:owner/repo.git#main"), {
    type: "git",
    host: "github.com",
    gitPath: "owner/repo",
  });
  assert.deepEqual(classifyPiPackageSource("./local-package"), {
    type: "local",
    localPath: "./local-package",
  });
});

test("redacts package settings sources and preserves filter metadata", () => {
  assert.equal(
      redactPackageSource("git+https://user:secret@example.com/owner/repo.git"),
      "git+https://example.com/owner/repo.git",
  );
  assert.deepEqual(normalizePiPackageSettingsEntry({
    source: "npm:@scope/tool",
    enabled: false,
  }, "workspace"), {
    source: "npm:@scope/tool",
    scope: "workspace",
    type: "npm",
    installedPath: null,
    filtered: true,
  });
});

test("validates skill fields and summarizes frontmatter", () => {
  assert.equal(normalizePiSkillName(" My-Skill "), "my-skill");
  assert.equal(normalizePiSkillDescription("Useful skill"), "Useful skill");
  assert.equal(normalizePiSkillContent("Do the thing"), "Do the thing");
  assertCode(() => normalizePiSkillName("bad_name"), "invalid_skill_name");
  assertCode(() => normalizePiSkillDescription("bad\nvalue"), "invalid_skill_description");
  assertCode(() => normalizePiSkillContent(""), "invalid_skill_content");

  const markdown = buildPiSkillMarkdown({
    name: "my-skill",
    description: "Useful skill",
    content: "---\nignored: true\n---\n\nDo the thing",
  });
  assert.deepEqual(skillSummaryFromMarkdown(markdown, {
    path: ".pi/skills/my-skill/SKILL.md",
    kind: "directory",
    editable: true,
  }), {
    name: "my-skill",
    description: "Useful skill",
    path: ".pi/skills/my-skill/SKILL.md",
    kind: "directory",
    editable: true,
    content: markdown,
  });
});
