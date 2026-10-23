"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizeModelCatalog,
  resolveModelRequest,
  savedModelSelection,
} = require("./workspaceRequestModels.service");

const catalog = normalizeModelCatalog([
  {providerId: "openai", modelId: "gpt-5", name: "GPT-5", available: true},
  {providerId: "anthropic", modelId: "claude-sonnet", name: "Sonnet", available: false},
]);

test("resolves exact and friendly workspace models without exposing provider credentials", () => {
  assert.deepEqual(resolveModelRequest({name: "GPT-5"}, catalog).selection, {providerId: "openai", modelId: "gpt-5"});
  assert.deepEqual(resolveModelRequest({providerId: "openai", modelId: "gpt-5"}, catalog).selection, {providerId: "openai", modelId: "gpt-5"});
  assert.deepEqual(resolveModelRequest(null, catalog, {modelSelection: {providerId: "openai", modelId: "gpt-5"}}).selection,
      {providerId: "openai", modelId: "gpt-5"});
});

test("rejects stale and unauthenticated target selections instead of silently falling back", () => {
  assert.throws(() => resolveModelRequest(null, catalog, {modelSelection: {providerId: "openai", modelId: "old-model"}}),
      (error) => error.publicMessage === "workspace_request_model_unavailable");
  assert.throws(() => resolveModelRequest({providerId: "anthropic", modelId: "claude-sonnet"}, catalog),
      (error) => error.publicMessage === "workspace_request_provider_auth_required");
});

test("reads only supported saved target model locations", () => {
  assert.deepEqual(savedModelSelection({agentRuntimeSettings: {modelSelection: {providerId: "openai", modelId: "gpt-5"}}}),
      {providerId: "openai", modelId: "gpt-5"});
  assert.equal(savedModelSelection({modelSelection: {providerId: "openai"}}), null);
});

test("does not collapse identical friendly names across providers", () => {
  const overlapping = normalizeModelCatalog([
    {providerId: "openai", modelId: "shared", name: "Shared", available: true},
    {providerId: "anthropic", modelId: "shared", name: "Shared", available: true},
  ]);
  assert.throws(() => resolveModelRequest("Shared", overlapping),
      (error) => error.publicMessage === "workspace_request_model_ambiguous");
  assert.deepEqual(resolveModelRequest({name: "Shared", providerId: "anthropic"}, overlapping).selection,
      {providerId: "anthropic", modelId: "shared"});
});
