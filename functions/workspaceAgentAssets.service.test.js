"use strict";

const assert = require("assert");
const {
  createWorkspaceAgentAssetsService,
  normalizePiSkillContent,
  normalizePiSkillDescription,
  normalizePiSkillName,
  normalizePiSkillPayload,
  normalizeWorkspaceSubagentPayload,
  sessionSupportsWorkspaceSkills,
  sessionSupportsWorkspaceSubagents,
} = require("./workspaceAgentAssets.service");

function publicMessage(error) {
  return error && error.publicMessage;
}

assert.deepStrictEqual(normalizePiSkillPayload({
  name: " My-Skill ",
  description: "  Does work  ",
  instructions: "  Use this carefully  ",
}), {name: "my-skill", description: "Does work", content: "Use this carefully"});
assert.strictEqual(normalizePiSkillName("skill-1"), "skill-1");
assert.throws(() => normalizePiSkillName("Bad Name"), (error) => publicMessage(error) === "invalid_skill_name");
assert.strictEqual(normalizePiSkillDescription("x".repeat(1024)).length, 1024);
assert.throws(() => normalizePiSkillDescription(""), (error) => publicMessage(error) === "invalid_skill_description");
assert.strictEqual(normalizePiSkillContent("x".repeat(128 * 1024)).length, 128 * 1024);
assert.throws(() => normalizePiSkillContent("bad\u0000content"), (error) => publicMessage(error) === "invalid_skill_content");
assert.deepStrictEqual(normalizeWorkspaceSubagentPayload({
  name: " Review-Code ",
  description: " Review changes ",
  developerInstructions: " Check the diff ",
}), {name: "review-code", description: "Review changes", instructions: "Check the diff"});

for (const terminalKind of ["pi", "codex"]) {
  assert.strictEqual(sessionSupportsWorkspaceSkills({terminalKind}), true);
  assert.strictEqual(sessionSupportsWorkspaceSubagents({terminalKind}), true);
}
assert.strictEqual(sessionSupportsWorkspaceSkills({terminalKind: "shell"}), false);
assert.strictEqual(sessionSupportsWorkspaceSubagents({terminalKind: "shell"}), false);

async function assertServiceError(fn, expectedStatus, expectedMessage) {
  await assert.rejects(fn, (error) => error.status === expectedStatus && error.publicMessage === expectedMessage);
}

const piSessionSnap = {data: () => ({serviceUrl: "https://runner", shutdownToken: "token", terminalKind: "pi"})};
const codexSessionSnap = {data: () => ({serviceUrl: "https://runner", shutdownToken: "token", terminalKind: "codex"})};
const shellSessionSnap = {data: () => ({serviceUrl: "https://runner", shutdownToken: "token", terminalKind: "shell"})};

function serviceForSession(sessionSnap, calls = [], requestRunnerJson) {
  return createWorkspaceAgentAssetsService({
    requireWorkspace: async () => ({}),
    requireSession: async () => ({sessionSnap}),
    requestRunnerJson: requestRunnerJson || (async (session, routePath, options) => {
      calls.push({session, routePath, options});
      return {ok: true, routePath, body: options.body || null};
    }),
  });
}

(async () => {
  await assertServiceError(
      () => serviceForSession(shellSessionSnap).saveWorkspaceSkill("uid", "workspace", "session", {
        name: "review-code", description: "Review code", content: "Check the diff",
      }), 501, "runner_skill_save_unsupported",
  );
  await assertServiceError(
      () => serviceForSession(shellSessionSnap).saveWorkspaceSubagent("uid", "workspace", "session", {
        name: "review-code", description: "Review code", instructions: "Check the diff",
      }), 501, "runner_subagent_save_unsupported",
  );

  const calls = [];
  const service = serviceForSession(codexSessionSnap, calls);
  const skillResult = await service.savePiSkill("uid", "workspace", "session", {
    name: "review-code", description: "Review code", content: "Check the diff",
  });
  assert.strictEqual(skillResult.ok, true);
  assert.strictEqual(calls[0].routePath, "/skills");
  assert.deepStrictEqual(calls[0].options.body, {name: "review-code", description: "Review code", content: "Check the diff"});

  const subagentResult = await service.saveWorkspaceSubagent("uid", "workspace", "session", {
    name: "review-code", description: "Review code", instructions: "Check the diff",
  });
  assert.strictEqual(subagentResult.ok, true);
  assert.strictEqual(calls[1].routePath, "/subagents");
  assert.deepStrictEqual(calls[1].options.body, {name: "review-code", description: "Review code", instructions: "Check the diff"});

  const fallbackCalls = [];
  const fallbackService = serviceForSession(piSessionSnap, fallbackCalls, async (session, routePath, options) => {
    fallbackCalls.push({session, routePath, options});
    if (routePath === "/skills") {
      const error = new Error("runner_skill_save_unsupported");
      error.status = 501;
      error.publicMessage = "runner_skill_save_unsupported";
      throw error;
    }
    return {ok: true, routePath};
  });
  const fallbackResult = await fallbackService.saveWorkspaceSkill("uid", "workspace", "session", {
    name: "review-code", description: "Review code", content: "Check the diff",
  });
  assert.strictEqual(fallbackResult.routePath, "/pi/skills");
  assert.deepStrictEqual(fallbackCalls.map((call) => call.routePath), ["/skills", "/pi/skills"]);

  console.log("workspace agent assets service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
