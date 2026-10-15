"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const METADATA_FILE = "mapache-models.json";
const isCustomPiProvider = (value) => /^custom-[a-z0-9][a-z0-9-]{0,62}$/.test(value || "");
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const text = (value) => typeof value === "string" && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;

// Match strings first so comment markers inside URLs remain intact.
function parseModelConfig(content) {
  try {
    return JSON.parse(String(content).replace(/"(?:\\.|[^"\\])*"|\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g,
        (token) => token.startsWith("/") ? " " : token));
  } catch { return undefined; }
}

function endpoint(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return url.href.replace(/\/+$/, "");
  } catch { return undefined; }
}

function compatibility(value) {
  const result = {};
  for (const key of ["supportsStore", "supportsDeveloperRole", "supportsReasoningEffort", "supportsUsageInStreaming", "supportsStrictMode", "supportsFinishReason", "supportsThinkingTokenBudget", "supportsOpenAIGrammarTools", "requiresReasoningContentOnAssistantMessages", "requiresToolResultName", "requiresAssistantAfterToolResult", "requiresThinkingAsText", "requiresMistralToolIds"]) {
    if (typeof value?.[key] === "boolean") result[key] = value[key];
  }
  if (["max_tokens", "max_completion_tokens"].includes(value?.maxTokensField)) result.maxTokensField = value.maxTokensField;
  for (const [key, values] of Object.entries({
    thinkingFormat: ["reasoning_effort", "openrouter", "deepseek", "together", "baseten", "zai", "qwen", "chat-template", "qwen-chat-template"],
    thinkingTokenBudgetField: ["thinking_token_budget", "thinking_budget", "thinking_budget_tokens"],
  })) if (values.includes(value?.[key])) result[key] = value[key];
  return result;
}

// Explicit projection: never checkpoint keys, headers, commands, model-specific
// endpoints, or unknown fields. Raw models.json remains capture-excluded.
function sanitizeCustomModels(input) {
  const providers = {};
  for (const [id, raw] of Object.entries(object(input?.providers)).filter(([id]) => isCustomPiProvider(id)).slice(0, 100)) {
    if (!isCustomPiProvider(id)) continue;
    const p = object(raw);
    const baseUrl = endpoint(p.baseUrl);
    if (!baseUrl || p.api !== "openai-completions") continue;
    providers[id] = {
      baseUrl, api: "openai-completions", compat: compatibility(p.compat),
      ...(text(p.name) ? {name: p.name} : {}),
      models: (Array.isArray(p.models) ? p.models : []).slice(0, 500).flatMap((model) => {
        if (!text(model?.id)) return [];
        const m = {id: model.id};
        if (text(model.name)) m.name = model.name;
        if (typeof model.reasoning === "boolean") m.reasoning = model.reasoning;
        if (Array.isArray(model.input)) m.input = model.input.filter((v) => ["text", "image"].includes(v));
        for (const k of ["contextWindow", "maxTokens"]) {
          if (Number.isSafeInteger(model[k]) && model[k] > 0) m[k] = model[k];
        }
        m.compat = compatibility(model.compat);
        if (model.cost && typeof model.cost === "object") {
          m.cost = {};
          for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
            if (Number.isFinite(model.cost[k]) && model.cost[k] >= 0) m.cost[k] = model.cost[k];
          }
        }
        return [m];
      }),
    };
  }
  return {providers};
}

async function readConfig(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("invalid_custom_model_config");
    return parseModelConfig(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function materializeCustomModels(agentDir, auth) {
  if (!agentDir) return;
  const file = path.join(agentDir, "models.json");
  const live = await readConfig(file);
  // Leave malformed live files to Pi's existing config error UI; never destroy them.
  if (live === undefined) return;
  const restored = live || await readConfig(path.join(agentDir, METADATA_FILE));
  const safe = sanitizeCustomModels(restored);
  const providers = {...object(live?.providers)};
  // Deselected/deleted custom connections cannot retain inline credentials.
  for (const id of Object.keys(providers)) if (isCustomPiProvider(id)) delete providers[id];
  Object.assign(providers, safe.providers);
  for (const [id, credential] of Object.entries(auth)) {
    if (!isCustomPiProvider(id)) continue;
    const baseUrl = endpoint(credential.mapacheBaseUrl);
    if (!baseUrl) continue;
    const saved = safe.providers[id];
    providers[id] = saved?.baseUrl === baseUrl ? saved : {baseUrl, api: "openai-completions", models: []};
  }
  if (!live && !Object.keys(providers).length) return;
  await fs.mkdir(agentDir, {recursive: true, mode: 0o700});
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({providers}, null, 2) + "\n", {mode: 0o600});
  await fs.rename(temporary, file);
}

module.exports = {parseModelConfig, METADATA_FILE, isCustomPiProvider, sanitizeCustomModels, materializeCustomModels};
