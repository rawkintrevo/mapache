"use strict";

const assert = require("node:assert/strict");
const {createPiModelsService, normalizeScopedModels} = require("./piModels.service");

(async () => {
  let sessionData = {harnessId: "pi", serviceUrl: "https://runner", shutdownToken: "token"};
  const calls = [];
  const sessionSnap = {
    data: () => sessionData,
    ref: {set: async (update, options) => {
      assert.deepEqual(options, {merge: true});
      sessionData = {...sessionData, ...update};
    }},
  };
  const service = createPiModelsService({
    admin: {firestore: {FieldValue: {serverTimestamp: () => "timestamp"}}},
    requireWorkspace: async () => ({}),
    requireSession: async () => ({sessionSnap}),
    requestRunnerJson: async (session, routePath, options) => {
      calls.push({session, routePath, options});
      return routePath === "/models" && options.method === "PUT" ? {ok: true} : {models: []};
    },
  });

  assert.deepEqual(await service.listPiModels("uid", "workspace", "session"), {models: []});
  assert.equal(calls[0].routePath, "/models");
  const saved = await service.savePiModelScope("uid", "workspace", "session", {
    scopedModels: [" openai-codex/gpt-5.5 ", "openai-codex/gpt-5.5"],
  });
  assert.deepEqual(saved.scopedModels, ["openai-codex/gpt-5.5"]);
  assert.deepEqual(sessionData.piScopedModels, ["openai-codex/gpt-5.5"]);
  assert.deepEqual(normalizeScopedModels([]), []);

  sessionData = {harnessId: "codex", serviceUrl: "https://runner", shutdownToken: "token"};
  await assert.rejects(
      service.listPiModels("uid", "workspace", "session"),
      (error) => error.status === 400 && error.publicMessage === "pi_models_unsupported",
  );
  console.log("pi models service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
