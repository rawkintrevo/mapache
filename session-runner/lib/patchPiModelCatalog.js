"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_OVERRIDES_PATH = path.join(__dirname, "piModelCatalogOverrides.json");

function applyPiModelCatalogOverrides(piWebUiRoot, options = {}) {
  const root = String(piWebUiRoot || "").trim();
  if (!root) throw new Error("pi_web_ui_root_required");
  const packagePath = path.join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data", "openai-codex.json");
  const overridesPath = options.overridesPath || DEFAULT_OVERRIDES_PATH;
  const catalog = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const overrides = JSON.parse(fs.readFileSync(overridesPath, "utf8"));
  const added = [];

  for (const model of overrides.models || []) {
    if (!model || model.provider !== "openai-codex" || model.api !== "openai-codex-responses" || !model.id) {
      throw new Error("pi_model_catalog_override_invalid");
    }
    const providerCatalog = catalog[model.api];
    if (!providerCatalog || typeof providerCatalog !== "object" || Array.isArray(providerCatalog)) {
      throw new Error("pi_model_catalog_provider_missing");
    }
    if (!providerCatalog[model.id]) {
      providerCatalog[model.id] = model;
      added.push(model.id);
    }
  }

  if (added.length) fs.writeFileSync(packagePath, `${JSON.stringify(catalog)}\n`, "utf8");
  return {added, source: overrides.source || null};
}

if (require.main === module) {
  try {
    const result = applyPiModelCatalogOverrides(process.argv[2]);
    console.log(`Pi model catalog override: added ${result.added.join(", ") || "no missing models"}`);
  } catch (error) {
    console.error(String(error?.message || "pi_model_catalog_patch_failed"));
    process.exitCode = 1;
  }
}

module.exports = {applyPiModelCatalogOverrides};
