"use strict";
const assert = require("node:assert/strict");
const {isCustomPiProvider, customPiCredential, normalizeCustomPiEndpoint} = require("./customPiProviders.helpers");
const {normalizePiAuthProviderKey, normalizePiAuthSelection} = require("./agentAuth.service");
for (const id of ["custom-lab", "custom-gpu-2"]) assert.equal(normalizePiAuthProviderKey(id), id);
for (const id of ["custom-", "custom-OpenAI", "custom-../x", "custom-x.y", "__proto__", "openai-compatible"]) {
  assert.equal(isCustomPiProvider(id), false);
  assert.throws(() => normalizePiAuthProviderKey(id));
}
for (const url of ["file:///secret", "https://user:secret@host/v1", "https://host/v1?key=secret", "https://host/#secret", ""]) {
  assert.throws(() => normalizeCustomPiEndpoint(url));
}
assert.deepEqual(customPiCredential("custom-lab", {baseUrl: "https://HOST/v1/"}, "key"), {
  type: "api_key", key: "key", mapacheBaseUrl: "https://host/v1",
});
assert.deepEqual(normalizePiAuthSelection({"custom-lab": "a", "custom-gpu": "a", openai: "b"}, {
  a: {providerKey: "custom-lab"}, b: {providerKey: "openai"},
}), {"custom-lab": "a", openai: "b"});
console.log("custom Pi provider validation tests passed");
