"use strict";

const {httpError} = require("./backendUtils.helpers");

// A namespace separate from every built-in provider, stable across key rotation.
function isCustomPiProvider(value) {
  return typeof value === "string" && /^custom-[a-z0-9][a-z0-9-]{0,62}$/.test(value);
}

function normalizeCustomPiEndpoint(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/+$/, "");
  } catch {
    throw httpError(400, "invalid_custom_provider_endpoint");
  }
}

function customPiCredential(provider, payload, key) {
  if (!isCustomPiProvider(provider)) return {type: "api_key", key};
  return {
    type: "api_key",
    key,
    mapacheBaseUrl: normalizeCustomPiEndpoint(payload.baseUrl),
  };
}

module.exports = {isCustomPiProvider, normalizeCustomPiEndpoint, customPiCredential};
