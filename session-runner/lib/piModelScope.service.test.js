"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {createPiModelScopeService, normalizeScopedModels, parsePiModelList} = require("./piModelScope.service");

function createHarness(t, session = {}, settings = {}, configOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mapache-pi-scope-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const piAgentDir = path.join(root, ".pi", "agent");
  fs.mkdirSync(piAgentDir, {recursive: true});
  fs.writeFileSync(path.join(piAgentDir, "settings.json"), JSON.stringify(settings));
  let current = {...session};
  const ref = {
    get: async () => ({exists: true, data: () => current}),
    set: async (update, options) => {
      assert.deepEqual(options, {merge: true});
      current = {...current, ...update};
    },
  };
  const service = createPiModelScopeService({
    admin: {firestore: {FieldValue: {serverTimestamp: () => "timestamp"}}},
    config: {
      harnessId: "pi",
      piAgentDir,
      sessionId: "session-1",
      workspaceId: "workspace-1",
      ...configOverrides,
    },
    db: {collection: () => ({doc: () => ({collection: () => ({doc: () => ref})})})},
  });
  return {
    readSettings: () => JSON.parse(fs.readFileSync(path.join(piAgentDir, "settings.json"), "utf8")),
    service,
    session: () => current,
  };
}

test("new sessions clear enabledModels inherited from the workspace home archive", async (t) => {
  const harness = createHarness(t, {restartedAt: null}, {
    enabledModels: ["openai/gpt-5.5"],
    theme: "dark",
  });

  const result = await harness.service.restore();

  assert.deepEqual(harness.readSettings(), {theme: "dark"});
  assert.deepEqual(harness.session().piScopedModels, []);
  assert.equal(result.initialized, true);
});

test("legacy restarts clear ambiguous enabledModels inherited from workspace state", async (t) => {
  const harness = createHarness(t, {restartedAt: "timestamp"}, {
    enabledModels: ["openai/gpt-5.5", "openai-codex/gpt-5.5"],
  });

  const result = await harness.service.restore();

  assert.deepEqual(harness.readSettings(), {});
  assert.deepEqual(harness.session().piScopedModels, []);
  assert.equal(result.initialized, true);
});

test("session scope replaces a different scope restored from the shared home archive", async (t) => {
  const harness = createHarness(t, {piScopedModels: ["openai-codex/gpt-5.5"]}, {
    enabledModels: ["google/gemini-*"],
    quietStartup: true,
  });

  await harness.service.restore();

  assert.deepEqual(harness.readSettings(), {
    enabledModels: ["openai-codex/gpt-5.5"],
    quietStartup: true,
  });
});

test("persist records saved Pi model scope without rewriting unchanged state", async (t) => {
  const harness = createHarness(t, {piScopedModels: ["openai/gpt-5.5"]}, {
    enabledModels: ["openai-codex/gpt-5.5", "openai-codex/gpt-5.5"],
  });

  const first = await harness.service.persist();
  const second = await harness.service.persist();

  assert.deepEqual(harness.session().piScopedModels, ["openai-codex/gpt-5.5"]);
  assert.equal(first.unchanged, undefined);
  assert.equal(second.unchanged, true);
});

test("legacy Pi sessions fall back to terminalKind when harnessId is absent", async (t) => {
  const harness = createHarness(
      t,
      {piScopedModels: ["openai-codex/gpt-5.5"]},
      {},
      {harnessId: "", terminalKind: "pi"},
  );

  assert.equal((await harness.service.restore()).skipped, undefined);
  assert.deepEqual(harness.readSettings().enabledModels, ["openai-codex/gpt-5.5"]);
});

test("normalizes invalid and duplicate model patterns", () => {
  assert.deepEqual(normalizeScopedModels([" openai/gpt-5.5 ", "", null, "openai/gpt-5.5"]), ["openai/gpt-5.5"]);
});

test("parses Pi list-models table output", () => {
  assert.deepEqual(parsePiModelList([
    "provider      model       context  max-out  thinking  images",
    "openai-codex  gpt-5.5     400K     128K     yes       yes",
    "google        gemini-3.1  1M       64K      yes       yes",
  ].join("\n")), [
    {id: "openai-codex/gpt-5.5", provider: "openai-codex", model: "gpt-5.5", context: "400K", maxOutput: "128K", reasoning: true, images: true},
    {id: "google/gemini-3.1", provider: "google", model: "gemini-3.1", context: "1M", maxOutput: "64K", reasoning: true, images: true},
  ]);
});
