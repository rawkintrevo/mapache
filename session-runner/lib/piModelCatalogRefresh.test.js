"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  DEFAULT_PI_MODEL_CATALOG_URL,
  parseRemotePiModelCatalog,
  refreshPiModelCatalog,
} = require("./piModelCatalogRefresh");

function model(provider, id, api = provider === "openai-codex" ? "openai-codex-responses" : "openai-responses") {
  return {
    id,
    name: id.toUpperCase(),
    provider,
    api,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    type: "chat",
  };
}

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mapache-pi-model-catalog-"));
  const dataDir = path.join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data");
  await fsp.mkdir(dataDir, {recursive: true});
  await fsp.writeFile(path.join(dataDir, "openai-codex.json"), JSON.stringify({
    "openai-codex-responses": {"gpt-old": model("openai-codex", "gpt-old")},
  }));
  await fsp.writeFile(path.join(dataDir, "openai.json"), JSON.stringify({
    "openai-responses": {"gpt-old": model("openai", "gpt-old")},
  }));
  await fsp.writeFile(path.join(dataDir, "azure-openai-responses.json"), JSON.stringify({
    "azure-openai-responses": {"chat-latest": model("azure-openai-responses", "chat-latest", "azure-openai-responses")},
  }));
  return {root, dataDir, cachePath: path.join(root, "state", "model-catalog.json")};
}

function response(payload, headers = {}) {
  return {
    ok: true,
    status: 200,
    headers: {get: (name) => headers[String(name).toLowerCase()] || null},
    json: async () => payload,
  };
}

test("parses provider arrays and ignores malformed or unsupported model types", () => {
  const parsed = parseRemotePiModelCatalog({
    "openai-codex": [model("openai-codex", "gpt-new"), {...model("openai-codex", "image"), type: "image"}],
    openai: {"gpt-new": model("openai", "gpt-new")},
    malformed: [{provider: "malformed", api: "openai-responses"}],
    unsupported: [{...model("unsupported", "classifier"), type: "audio"}],
  });
  assert.deepEqual(parsed.map((entry) => `${entry.provider}/${entry.id}`).sort(), [
    "openai-codex/gpt-new",
    "openai-codex/image",
    "openai/gpt-new",
  ]);
});

test("fetches the current Pi catalog and merges supported providers before child startup", async (t) => {
  const f = await fixture();
  t.after(() => fsp.rm(f.root, {recursive: true, force: true}));
  const payload = {
    "openai-codex": [model("openai-codex", "gpt-6.2-sol")],
    openai: [model("openai", "gpt-6.2-sol")],
    azure: [model("azure", "gpt-6.2-sol", "azure-openai-responses")],
    meta: [model("meta", "muse-ember")],
  };
  let request;
  const result = await refreshPiModelCatalog({
    cachePath: f.cachePath,
    fetchImpl: async (url, options) => {
      request = {url, options};
      return response(payload, {etag: "catalog-v1", "last-modified": "Thu, 19 Nov 2026 12:00:00 GMT"});
    },
    now: () => 10_000,
    piWebUiRoot: f.root,
  });

  assert.equal(result.status, "validated");
  assert.equal(result.modelCount, 3);
  assert.equal(result.providerCount, 3);
  assert.equal(request.url, DEFAULT_PI_MODEL_CATALOG_URL);
  assert.equal(request.options.headers["User-Agent"], undefined);
  const codex = JSON.parse(await fsp.readFile(path.join(f.dataDir, "openai-codex.json"), "utf8"));
  const openai = JSON.parse(await fsp.readFile(path.join(f.dataDir, "openai.json"), "utf8"));
  const azure = JSON.parse(await fsp.readFile(path.join(f.dataDir, "azure-openai-responses.json"), "utf8"));
  assert.equal(codex["openai-codex-responses"]["gpt-6.2-sol"].name, "GPT-6.2-SOL");
  assert.equal(openai["openai-responses"]["gpt-6.2-sol"].name, "GPT-6.2-SOL");
  assert.equal(azure["azure-openai-responses"]["gpt-6.2-sol"].provider, "azure-openai-responses");
  assert.equal(fs.existsSync(f.cachePath), true);
  const cache = JSON.parse(await fsp.readFile(f.cachePath, "utf8"));
  assert.deepEqual(cache.models.map((entry) => entry.id).sort(), ["gpt-6.2-sol", "gpt-6.2-sol", "gpt-6.2-sol"]);
  assert.equal(cache.lastError, null);
});

test("uses the last successful catalog during the refresh interval and after a network failure", async (t) => {
  const f = await fixture();
  t.after(() => fsp.rm(f.root, {recursive: true, force: true}));
  const payload = {"openai-codex": [model("openai-codex", "gpt-6.2-sol")]};
  await refreshPiModelCatalog({
    cachePath: f.cachePath,
    fetchImpl: async () => response(payload),
    now: () => 10_000,
    piWebUiRoot: f.root,
  });

  let calls = 0;
  const cached = await refreshPiModelCatalog({
    cachePath: f.cachePath,
    fetchImpl: async () => {
      calls++;
      throw new Error("network should not be used while fresh");
    },
    now: () => 10_001,
    piWebUiRoot: f.root,
  });
  assert.equal(cached.status, "cached");
  assert.equal(calls, 0);

  const warnings = [];
  const stale = await refreshPiModelCatalog({
    cachePath: f.cachePath,
    fetchImpl: async () => {
      throw new Error("offline");
    },
    logger: {warn: (_message, details) => warnings.push(details)},
    now: () => 10_000 + 5 * 60 * 60 * 1000,
    piWebUiRoot: f.root,
  });
  assert.equal(stale.status, "stale");
  assert.equal(stale.modelCount, 1);
  assert.equal(warnings[0].error, "pi_model_catalog_fetch_failed:offline");
  const cache = JSON.parse(await fsp.readFile(f.cachePath, "utf8"));
  assert.equal(cache.models[0].id, "gpt-6.2-sol");
  assert.equal(cache.lastError, "pi_model_catalog_fetch_failed:offline");
});

test("keeps the bundled catalog when the first remote refresh is malformed", async (t) => {
  const f = await fixture();
  t.after(() => fsp.rm(f.root, {recursive: true, force: true}));
  const warnings = [];
  const result = await refreshPiModelCatalog({
    cachePath: f.cachePath,
    fetchImpl: async () => response({}),
    logger: {warn: (_message, details) => warnings.push(details)},
    now: () => 20_000,
    piWebUiRoot: f.root,
  });
  assert.equal(result.status, "fallback");
  assert.equal(result.modelCount, 0);
  assert.equal(warnings.length, 1);
  const codex = JSON.parse(await fsp.readFile(path.join(f.dataDir, "openai-codex.json"), "utf8"));
  assert.equal(codex["openai-codex-responses"]["gpt-old"].id, "gpt-old");
});

test("records an unavailable fetcher without preventing the embedded catalog from starting", async (t) => {
  const f = await fixture();
  t.after(() => fsp.rm(f.root, {recursive: true, force: true}));
  const warnings = [];
  const result = await refreshPiModelCatalog({
    cachePath: f.cachePath,
    fetchImpl: null,
    logger: {warn: (_message, details) => warnings.push(details)},
    now: () => 30_000,
    piWebUiRoot: f.root,
  });
  assert.equal(result.status, "fallback");
  assert.equal(result.error, "pi_model_catalog_fetch_unavailable");
  assert.equal(warnings[0].error, "pi_model_catalog_fetch_unavailable");
});
