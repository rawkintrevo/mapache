"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {applyPiModelCatalogOverrides} = require("./patchPiModelCatalog");

test("adds only absent pinned model metadata to the Pi AI provider catalog", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mapache-pi-model-catalog-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const packageRoot = path.join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data");
  fs.mkdirSync(packageRoot, {recursive: true});
  const packagePath = path.join(packageRoot, "openai-codex.json");
  const existing = {id: "gpt-5.5", name: "GPT-5.5"};
  fs.writeFileSync(packagePath, JSON.stringify({"openai-codex-responses": {"gpt-5.5": existing}}));

  const first = applyPiModelCatalogOverrides(root);
  const patched = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  assert.deepEqual(first.added, ["gpt-6-astra"]);
  assert.deepEqual(patched["openai-codex-responses"]["gpt-5.5"], existing);
  assert.equal(patched["openai-codex-responses"]["gpt-6-astra"].provider, "openai-codex");
  assert.equal(patched["openai-codex-responses"]["gpt-6-astra"].api, "openai-codex-responses");

  const second = applyPiModelCatalogOverrides(root);
  assert.deepEqual(second.added, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(packagePath, "utf8")), patched);
});
