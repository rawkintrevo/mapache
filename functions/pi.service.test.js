"use strict";

const assert = require("assert");
const {
  createPiService,
  normalizePiSkillContent,
  normalizePiSkillDescription,
  normalizePiSkillName,
  normalizePiSkillPayload,
  sessionSupportsWorkspaceSkills,
} = require("./pi.service");

function publicMessage(error) {
  return error && error.publicMessage;
}

assert.deepStrictEqual(normalizePiSkillPayload({
  name: " My-Skill ",
  description: "  Does work  ",
  instructions: "  Use this carefully  ",
}), {
  name: "my-skill",
  description: "Does work",
  content: "Use this carefully",
});
assert.strictEqual(normalizePiSkillName("skill-1"), "skill-1");
assert.throws(() => normalizePiSkillName("Bad Name"), (error) => publicMessage(error) === "invalid_skill_name");
assert.strictEqual(normalizePiSkillDescription("x".repeat(1024)).length, 1024);
assert.throws(() => normalizePiSkillDescription(""), (error) => publicMessage(error) === "invalid_skill_description");
assert.strictEqual(normalizePiSkillContent("x".repeat(128 * 1024)).length, 128 * 1024);
assert.throws(() => normalizePiSkillContent("bad\u0000content"), (error) => publicMessage(error) === "invalid_skill_content");

assert.strictEqual(sessionSupportsWorkspaceSkills({terminalKind: "pi"}), true);
assert.strictEqual(sessionSupportsWorkspaceSkills({terminalKind: "codex"}), true);
assert.strictEqual(sessionSupportsWorkspaceSkills({terminalKind: "shell"}), false);

async function assertServiceError(fn, expectedStatus, expectedMessage) {
  await assert.rejects(fn, (error) => error.status === expectedStatus && error.publicMessage === expectedMessage);
}

const runningSessionSnap = {
  data: () => ({serviceUrl: "https://runner", shutdownToken: "token", terminalKind: "pi"}),
  ref: {set: async () => {}},
};
const shellSessionSnap = {
  data: () => ({serviceUrl: "https://runner", shutdownToken: "token", terminalKind: "shell"}),
  ref: {set: async () => {}},
};

function serviceForSession(sessionSnap, calls = []) {
  return createPiService({
    requireWorkspace: async () => ({}),
    requireSession: async () => ({sessionSnap}),
    requestRunnerJson: async (session, routePath, options) => {
      calls.push({session, routePath, options});
      return {ok: true, routePath, body: options.body || null};
    },
  });
}

(async () => {
  await assertServiceError(
      () => serviceForSession(shellSessionSnap).saveWorkspaceSkill("uid", "workspace", "session", {
        name: "review-code",
        description: "Review code",
        content: "Check the diff",
      }),
      501,
      "runner_skill_save_unsupported",
  );

  const calls = [];
  const result = await serviceForSession(runningSessionSnap, calls)
      .savePiSkill("uid", "workspace", "session", {
        name: "review-code",
        description: "Review code",
        content: "Check the diff",
      });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls[0].routePath, "/skills");
  assert.strictEqual(calls[0].options.method, "POST");
  assert.deepStrictEqual(calls[0].options.body, {
    name: "review-code",
    description: "Review code",
    content: "Check the diff",
  });
  assert.strictEqual(calls[0].options.notFoundError, "runner_skill_save_unsupported");
  assert.strictEqual(calls[0].options.unavailableError, "runner_skill_save_unavailable");

  const fallbackCalls = [];
  const fallbackService = createPiService({
    requireWorkspace: async () => ({}),
    requireSession: async () => ({sessionSnap: runningSessionSnap}),
    requestRunnerJson: async (session, routePath, options) => {
      fallbackCalls.push({session, routePath, options});
      if (routePath === "/skills") {
        const error = new Error("runner_skill_save_unsupported");
        error.status = 501;
        error.publicMessage = "runner_skill_save_unsupported";
        throw error;
      }
      return {ok: true, routePath};
    },
  });
  const fallbackResult = await fallbackService.saveWorkspaceSkill("uid", "workspace", "session", {
    name: "review-code",
    description: "Review code",
    content: "Check the diff",
  });
  assert.strictEqual(fallbackResult.routePath, "/pi/skills");
  assert.deepStrictEqual(fallbackCalls.map((call) => call.routePath), ["/skills", "/pi/skills"]);

  console.log("pi service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
