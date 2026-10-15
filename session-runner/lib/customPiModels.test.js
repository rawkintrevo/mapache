"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {parseModelConfig, sanitizeCustomModels, materializeCustomModels, METADATA_FILE} = require("./customPiModels");
const {captureAgentSnapshot} = require("./agentSnapshot.service");
const fixture = () => ({providers: {
  "custom-lab": {api: "openai-completions", baseUrl: "https://lab.example/v1", apiKey: "secret", headers: {Authorization: "secret"},
    compat: {supportsDeveloperRole: false, unknown: "secret"},
    models: [{id: "qwen", input: ["text"], contextWindow: 32768, maxTokens: 4096, headers: {Secret: "secret"}, baseUrl: "https://evil.example", apiKey: "!secret"}]},
  "custom-other": {api: "openai-completions", baseUrl: "https://other.example/v1", models: [{id: "other"}]},
  openai: {apiKey: "secret"},
}});

test("checkpoint projection strips every credential and endpoint override, then restores models with current keys", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "custom-pi-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const agentDir = path.join(root, "pi");
  await fs.mkdir(agentDir);
  await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify(fixture()));
  const snap = await captureAgentSnapshot({config: {piAgentDir: agentDir, workspaceId: "w", sessionId: "s", agentRuntimeGeneration: "1"},
    bootInstanceId: "b", stagingDir: path.join(root, "stage")});
  const record = snap.manifest.files.find((f) => f.path === `pi/${METADATA_FILE}`);
  assert.ok(record);
  assert.ok(!snap.manifest.files.some((f) => f.path === "pi/models.json"));
  const checkpoint = await fs.readFile(path.join(snap.stagingDir, record.path), "utf8");
  assert.ok(!checkpoint.includes("secret"));
  assert.ok(!checkpoint.includes("evil.example"));
  await fs.rm(path.join(agentDir, "models.json"));
  await fs.writeFile(path.join(agentDir, METADATA_FILE), checkpoint);
  const auth = {"custom-lab": {key: "rotated", mapacheBaseUrl: "https://lab.example/v1"},
    "custom-other": {key: "other-key", mapacheBaseUrl: "https://other.example/v1"}};
  await materializeCustomModels(agentDir, auth);
  const restored = JSON.parse(await fs.readFile(path.join(agentDir, "models.json"), "utf8"));
  assert.equal(restored.providers["custom-lab"].models[0].id, "qwen");
  assert.equal(restored.providers["custom-lab"].compat.supportsDeveloperRole, false);
  assert.equal(restored.providers["custom-other"].models[0].id, "other");
  assert.ok(!JSON.stringify(restored).includes("rotated"));
  await materializeCustomModels(agentDir, {});
  assert.equal(JSON.parse(await fs.readFile(path.join(agentDir, "models.json"))).providers["custom-lab"].models[0].id, "qwen");
  await materializeCustomModels(agentDir, {"custom-lab": {key: "new", mapacheBaseUrl: "https://new.example/v1"}});
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(agentDir, "models.json"))).providers["custom-lab"].models, []);
});

test("rejects secret URLs and unsupported APIs in restored metadata", () => {
  const input = fixture();
  input.providers["custom-lab"].baseUrl = "https://user:secret@lab.example/v1";
  input.providers["custom-other"].api = "anthropic-messages";
  assert.deepEqual(sanitizeCustomModels(input), {providers: {}});
});


test("JSON comments preserve URLs and malformed config cannot block or overwrite live Pi settings", async (t) => {
  assert.deepEqual(parseModelConfig('{/* hi */ "url":"https://host/v1" // comment\n}'), {url: "https://host/v1"});
  assert.equal(parseModelConfig('{"broken":'), undefined);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "custom-pi-invalid-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const content = '{"broken":';
  await fs.writeFile(path.join(root, "models.json"), content);
  await materializeCustomModels(root, {"custom-lab": {key: "key", mapacheBaseUrl: "https://lab.example/v1"}});
  assert.equal(await fs.readFile(path.join(root, "models.json"), "utf8"), content);
  await captureAgentSnapshot({config: {piAgentDir: root, workspaceId: "w", sessionId: "s", agentRuntimeGeneration: "1"},
    bootInstanceId: "b", stagingDir: path.join(root, "stage")});
});
