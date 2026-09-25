"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {defaultWorkspaceSkills} = require("./workspaceSkillCatalog");

const runnerRoot = path.join(__dirname, "..");
const reference = fs.readFileSync(path.join(runnerRoot, "reference", "mapache.md"), "utf8");
const skill = (name) => fs.readFileSync(path.join(runnerRoot, "seeded-skills", name, "SKILL.md"), "utf8");

test("operating reference stays bounded and all detailed skill paths ship in the image", () => {
  assert.ok(Buffer.byteLength(reference) < 8000, "keep the always-present reference small");
  const dockerfile = fs.readFileSync(path.join(runnerRoot, "Dockerfile.pi-chrome"), "utf8");
  assert.match(dockerfile, /^WORKDIR \/app$/m);
  assert.match(dockerfile, /^COPY reference \.\/reference$/m);
  assert.match(dockerfile, /^COPY seeded-skills \.\/seeded-skills$/m);
  const manifest = JSON.parse(fs.readFileSync(path.join(runnerRoot, "upstream", "pi-web-ui", "manifest.json"), "utf8"));
  assert.ok(manifest.patches.includes("patches/0016-managed-operating-reference.patch"));
  const links = [...reference.matchAll(/`\/app\/(seeded-skills\/[^`]+\/SKILL\.md)`/g)];
  assert.equal(links.length, 6);
  for (const [, relativePath] of links) {
    assert.ok(fs.existsSync(path.join(runnerRoot, relativePath)), relativePath);
  }
  assert.match(reference, /http:\/\/localhost:<port>\//);
  assert.match(reference, /not the user's personal computer/);
  assert.match(reference, /do not overwrite user-edited skills/);
});

test("chat scheduling guidance uses existing tools and states scheduling limitations", () => {
  const guidance = skill("mapache-automations");
  for (const tool of ["automations_list", "automations_create", "automations_schedule_preview", "automations_get", "automations_update", "automations_delete", "automation_runs_stop"]) {
    assert.ok(guidance.includes(tool), tool);
  }
  assert.match(guidance, /enabled: true/);
  assert.match(guidance, /not a native one-time job/);
  assert.match(guidance, /IANA timezone/);
  assert.match(guidance, /expectedRevision/);
  assert.match(guidance, /missing_model_selection/);
  assert.match(guidance, /Confirm only after a successful response/);
  assert.match(reference, /not native one-time jobs/);
  for (const workspaceSourceMode of ["blank", "github"]) {
    const names = defaultWorkspaceSkills({agentRuntimeEnabled: true, runtimeKind: "main", workspaceSourceMode})
        .map((entry) => entry.name);
    assert.equal(names.filter((name) => name === "mapache-automations").length, 1);
  }
});

test("browser skills teach direct localhost access rather than gateway commands", () => {
  for (const name of ["mapache-chrome", "mapache-preview-build", "mapache-api-hosting", "mapache-preview-qa"]) {
    const guidance = skill(name);
    assert.match(guidance, /http:\/\/localhost:/, name);
    assert.match(guidance, /chrome-devtools/, name);
    assert.doesNotMatch(guidance, /\$MAPACHE_PREVIEW_URL|\$MAPACHE_BROWSER_QA_COMMAND|\/preview\/status|\/preview\/logs/, name);
  }
});
