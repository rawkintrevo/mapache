"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  agentSnapshotStoragePrefix,
  captureAgentSnapshot,
  createAgentSnapshotService,
  parseCompleteJsonl,
} = require("./agentSnapshot.service");

function configFor(root, overrides = {}) {
  return {
    agentRuntimeEnabled: true,
    agentRuntimeGeneration: "7",
    agentStateRoot: path.join(root, "state"),
    harnessId: "pi",
    homeDir: path.join(root, "home"),
    internalStorageDir: ".mapache-internal",
    piAgentDir: path.join(root, "state", "pi"),
    piSessionDir: path.join(root, "state", "sessions"),
    piWebUiDataDir: path.join(root, "state", "ui"),
    prefix: "users/u/workspaces/workspace-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    ...overrides,
  };
}

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-agent-snapshot-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = configFor(root);
  await Promise.all([
    fs.mkdir(config.piAgentDir, {recursive: true}),
    fs.mkdir(config.piSessionDir, {recursive: true}),
    fs.mkdir(config.piWebUiDataDir, {recursive: true}),
  ]);
  return {config, root};
}

function entry(result, relativePath) {
  return result.manifest.files.find((file) => file.path === relativePath);
}

test("captures complete history, safe settings, UI state, and referenced uploads", async (t) => {
  const {config, root} = await makeFixture(t);
  const uploadPath = path.join(config.piWebUiDataDir, "uploads", "client-1", "123-note.txt");
  await fs.mkdir(path.dirname(uploadPath), {recursive: true});
  await fs.writeFile(uploadPath, "attachment bytes\n", {mode: 0o640});
  await fs.writeFile(path.join(config.piSessionDir, "chat.jsonl"), [
    JSON.stringify({type: "session", id: "first"}),
    JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: [{type: "text", text: `<file path="${uploadPath}" size="17" />`}],
      },
    }),
    JSON.stringify({type: "message", message: {role: "assistant", content: [{type: "text", text: "done"}]}}),
    "",
  ].join("\n"));
  await fs.writeFile(path.join(config.piAgentDir, "settings.json"), JSON.stringify({enabledModels: ["pi/test"]}));
  await fs.writeFile(path.join(config.piAgentDir, "auth.json"), JSON.stringify({token: "secret"}));
  await fs.writeFile(path.join(config.piAgentDir, "models.json"), JSON.stringify({providers: {secret: "do-not-copy"}}));
  await fs.writeFile(path.join(config.piAgentDir, "settings.lock"), "lock");
  await fs.writeFile(path.join(config.piWebUiDataDir, "client-state.json"), JSON.stringify({settings: {locale: "en"}}));
  await fs.writeFile(path.join(config.piWebUiDataDir, "auth.json"), JSON.stringify({token: "secret"}));
  await fs.writeFile(path.join(config.piWebUiDataDir, "token.json"), JSON.stringify({token: "secret"}));
  await fs.writeFile(path.join(config.piWebUiDataDir, "History.sqlite"), "secret-db");
  await fs.writeFile(path.join(config.piWebUiDataDir, "runtime.pid"), "123");
  await fs.mkdir(path.join(config.piWebUiDataDir, "cache"), {recursive: true});
  await fs.writeFile(path.join(config.piWebUiDataDir, "cache", "stale.json"), "{}");
  await fs.mkdir(path.join(config.piWebUiDataDir, "shortcuts"), {recursive: true});
  await fs.symlink("../client-state.json", path.join(config.piWebUiDataDir, "shortcuts", "current.json"));

  const stagingDir = path.join(root, "staging");
  const result = await captureAgentSnapshot({
    bootInstanceId: "boot-a",
    capturedAt: "2026-09-11T12:00:00.000Z",
    config,
    stagingDir,
    secretInventory: [
      {localPath: path.join(config.piAgentDir, "auth.json")},
      {localPath: path.join(config.piAgentDir, "models.json")},
      {localPath: path.join(config.piWebUiDataDir, "auth.json")},
    ],
  });

  assert.equal(result.manifest.manifestVersion, 1);
  assert.equal(result.manifest.storagePrefix,
      "users/u/workspaces/workspace-1/.mapache-internal/agent-snapshots/v1");
  assert.deepEqual(
      result.manifest.files.map((file) => file.path),
      [
        "pi/settings.json",
        "sessions/chat.jsonl",
        "ui/shortcuts/current.json",
        "ui/client-state.json",
        "uploads/client-1/123-note.txt",
      ].sort());
  assert.equal(entry(result, "sessions/chat.jsonl").completeRecords, true);
  assert.equal(entry(result, "sessions/chat.jsonl").recordCount, 3);
  assert.equal(await fs.readFile(path.join(stagingDir, "sessions/chat.jsonl"), "utf8"),
      await fs.readFile(path.join(config.piSessionDir, "chat.jsonl"), "utf8"));
  assert.equal(await fs.readFile(path.join(stagingDir, "uploads/client-1/123-note.txt"), "utf8"), "attachment bytes\n");
  assert.equal(await fs.readlink(path.join(stagingDir, "ui/shortcuts/current.json")), "../client-state.json");
  assert.equal(entry(result, "uploads/client-1/123-note.txt").mode, 0o640);
  assert.equal(entry(result, "uploads/client-1/123-note.txt").sha256,
      "d3c596beff3569ad0436f52ac241a1a38f17c1f97c5c253b59e5264a28718706");
  assert.equal(entry(result, "pi/auth.json"), undefined);
  assert.equal(entry(result, "pi/models.json"), undefined);
  assert.equal(entry(result, "ui/auth.json"), undefined);
  assert.equal(entry(result, "ui/token.json"), undefined);
  assert.equal(entry(result, "ui/History.sqlite"), undefined);
  assert.equal(entry(result, "ui/runtime.pid"), undefined);
  assert.equal(entry(result, "ui/cache/stale.json"), undefined);
  assert.equal(JSON.parse(await fs.readFile(result.manifestPath, "utf8")).bootInstanceId, "boot-a");
});

test("copies only complete JSONL records and marks a trailing live append", async (t) => {
  const {config, root} = await makeFixture(t);
  const source = path.join(config.piSessionDir, "live.jsonl");
  await fs.writeFile(source, `${JSON.stringify({id: "complete"})}\n{"id":"partial"`);
  const parsed = parseCompleteJsonl(await fs.readFile(source), source);
  assert.equal(parsed.truncated, true);
  assert.deepEqual(parsed.records, [{id: "complete"}]);
  assert.equal(parsed.content.toString(), `${JSON.stringify({id: "complete"})}\n`);

  const result = await captureAgentSnapshot({
    bootInstanceId: "boot-a",
    config,
    stagingDir: path.join(root, "staging"),
    secretInventory: [],
  });
  const manifestEntry = entry(result, "sessions/live.jsonl");
  assert.equal(manifestEntry.completeRecords, false);
  assert.equal(manifestEntry.recordCount, 1);
  assert.equal(await fs.readFile(path.join(result.stagingDir, "sessions/live.jsonl"), "utf8"),
      `${JSON.stringify({id: "complete"})}\n`);
});

test("rejects malformed non-trailing JSONL records", async (t) => {
  const {config, root} = await makeFixture(t);
  await fs.writeFile(path.join(config.piSessionDir, "broken.jsonl"), "{bad}\n");
  await assert.rejects(
      captureAgentSnapshot({bootInstanceId: "boot-a", config, stagingDir: path.join(root, "staging"), secretInventory: []}),
      (error) => error.code === "snapshot_malformed_jsonl",
  );
});

test("rejects a JSON/settings replacement detected before acceptance", async (t) => {
  const {config, root} = await makeFixture(t);
  const settingsPath = path.join(config.piAgentDir, "settings.json");
  await fs.writeFile(settingsPath, JSON.stringify({theme: "dark"}));
  await assert.rejects(
      captureAgentSnapshot({
        bootInstanceId: "boot-a",
        config,
        stagingDir: path.join(root, "staging"),
        secretInventory: [],
        beforeAccept: async () => fs.writeFile(settingsPath, JSON.stringify({theme: "light"})),
      }),
      (error) => error.code === "snapshot_source_changed",
  );
});

test("accepts valid array-shaped JSON UI state", async (t) => {
  const {config, root} = await makeFixture(t);
  const catalogPath = path.join(config.piWebUiDataDir, "subagent-templates.seeded.json");
  await fs.writeFile(catalogPath, JSON.stringify([{name: "fixture-template"}]));

  const result = await captureAgentSnapshot({
    bootInstanceId: "boot-a",
    config,
    stagingDir: path.join(root, "staging"),
    secretInventory: [],
  });

  assert.equal(entry(result, "ui/subagent-templates.seeded.json").path, "ui/subagent-templates.seeded.json");
  assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(result.stagingDir, "ui/subagent-templates.seeded.json"), "utf8")),
      [{name: "fixture-template"}],
  );
});

test("rejects traversal and unsafe symlinks instead of following them", async (t) => {
  const {config, root} = await makeFixture(t);
  const uploadRoot = path.join(config.piWebUiDataDir, "uploads");
  await fs.mkdir(path.join(uploadRoot, "client-1"), {recursive: true});
  await fs.writeFile(path.join(root, "outside.txt"), "outside");
  await fs.writeFile(path.join(config.piSessionDir, "traversal.jsonl"), `${JSON.stringify({
    type: "message",
    uploadPath: `${uploadRoot}/client-1/../outside.txt`,
  })}\n`);
  await assert.rejects(
      captureAgentSnapshot({bootInstanceId: "boot-a", config, stagingDir: path.join(root, "staging-1"), secretInventory: []}),
      (error) => error.code === "snapshot_path_traversal",
  );

  await fs.rm(path.join(config.piSessionDir, "traversal.jsonl"));
  await fs.symlink("../../outside.txt", path.join(config.piWebUiDataDir, "unsafe-link"));
  await assert.rejects(
      captureAgentSnapshot({bootInstanceId: "boot-a", config, stagingDir: path.join(root, "staging-2"), secretInventory: []}),
      (error) => error.code === "snapshot_unsafe_symlink",
  );
});

test("unmarked service skips the new capture path", async (t) => {
  const {config} = await makeFixture(t);
  const service = createAgentSnapshotService({config: {...config, agentRuntimeEnabled: false, agentUiVersion: ""}});
  const result = await service.capture({bootInstanceId: "boot-a"});
  assert.deepEqual(result, {
    enabled: false,
    skipped: true,
    storagePrefix: agentSnapshotStoragePrefix(config),
  });
});
