"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_PI_MODEL_CATALOG_URL = "https://pi.dev/api/models?types=chat%2Cimage%2Cclassifier";
const DEFAULT_PI_MODEL_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_PI_MODEL_CATALOG_TIMEOUT_MS = 4_000;
const MODEL_CATALOG_CACHE_VERSION = 1;
const MODEL_TYPES = new Set(["chat", "image", "classifier"]);

/**
 * Refresh the generated Pi provider JSON before the managed Agent imports it.
 *
 * Pi's hosted catalog intentionally varies by Pi version when a versioned
 * User-Agent is supplied. Mapache asks for the current default catalog instead
 * so model metadata can advance independently of the pinned embedded SDK. A
 * model may still fail at request time when the installed SDK lacks the
 * required protocol behavior; this function only publishes metadata.
 */
async function refreshPiModelCatalog(options = {}) {
  const fsImpl = options.fs || fs;
  const root = String(options.piWebUiRoot || "").trim();
  const cachePath = String(options.cachePath || "").trim();
  const sourceUrl = String(options.sourceUrl || DEFAULT_PI_MODEL_CATALOG_URL).trim();
  const fetchImpl = Object.prototype.hasOwnProperty.call(options, "fetchImpl") ? options.fetchImpl : globalThis.fetch;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const refreshIntervalMs = positiveNumber(options.refreshIntervalMs, DEFAULT_PI_MODEL_CATALOG_REFRESH_INTERVAL_MS);
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_PI_MODEL_CATALOG_TIMEOUT_MS);
  const logger = options.logger || console;

  if (!root) return result("skipped", {error: "pi_web_ui_root_required"});
  const dataDirs = findPiModelCatalogDataDirs(root, fsImpl);
  if (!dataDirs.length) return result("skipped", {error: "pi_model_catalog_not_found"});

  const cached = readCatalogCache(cachePath, fsImpl);
  const appliedCache = cached?.models?.length ? applyCatalogModels(dataDirs, cached.models, fsImpl) : emptyApplyResult();
  const checkedAt = Number(cached?.checkedAt || 0);
  const currentTime = Number(now());
  if (cached && checkedAt > 0 && currentTime - checkedAt < refreshIntervalMs) {
    return result("cached", {
      cachePath,
      checkedAt,
      modelCount: cached.models.length,
      appliedCount: appliedCache.appliedCount,
      providerCount: appliedCache.providerCount,
      sourceUrl: cached.sourceUrl || sourceUrl,
    });
  }

  if (typeof fetchImpl !== "function") {
    return recordFailure({
      cache: cached,
      cachePath,
      fsImpl,
      sourceUrl,
      now: currentTime,
      error: "pi_model_catalog_fetch_unavailable",
      appliedCache,
      logger,
    });
  }

  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, sourceUrl, {
      headers: {
        accept: "application/json",
        ...(cached?.etag ? {"if-none-match": cached.etag} : {}),
      },
      signal: options.signal,
    }, timeoutMs);
  } catch (error) {
    return recordFailure({
      cache: cached,
      cachePath,
      fsImpl,
      sourceUrl,
      now: currentTime,
      error: `pi_model_catalog_fetch_failed:${safeError(error)}`,
      appliedCache,
      logger,
    });
  }

  if (response?.status === 304 && cached) {
    const nextCache = {
      ...cached,
      checkedAt: currentTime,
      lastAttemptAt: currentTime,
      lastError: null,
      sourceUrl,
    };
    writeCatalogCache(cachePath, nextCache, fsImpl);
    return result("validated", {
      cachePath,
      checkedAt: currentTime,
      modelCount: cached.models.length,
      appliedCount: appliedCache.appliedCount,
      providerCount: appliedCache.providerCount,
      sourceUrl,
      notModified: true,
    });
  }
  if (!response?.ok) {
    return recordFailure({
      cache: cached,
      cachePath,
      fsImpl,
      sourceUrl,
      now: currentTime,
      error: `pi_model_catalog_http_${response?.status || "unavailable"}`,
      appliedCache,
      logger,
    });
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return recordFailure({
      cache: cached,
      cachePath,
      fsImpl,
      sourceUrl,
      now: currentTime,
      error: `pi_model_catalog_invalid_json:${safeError(error)}`,
      appliedCache,
      logger,
    });
  }

  let remoteModels;
  try {
    remoteModels = parseRemotePiModelCatalog(payload);
  } catch (error) {
    return recordFailure({
      cache: cached,
      cachePath,
      fsImpl,
      sourceUrl,
      now: currentTime,
      error: safeError(error),
      appliedCache,
      logger,
    });
  }

  const applied = applyCatalogModels(dataDirs, remoteModels, fsImpl);
  const matchedModels = applied.matchedModels;
  const nextCache = {
    version: MODEL_CATALOG_CACHE_VERSION,
    sourceUrl,
    checkedAt: currentTime,
    lastAttemptAt: currentTime,
    lastModified: parseLastModified(response.headers?.get?.("last-modified")),
    etag: response.headers?.get?.("etag") || null,
    lastError: null,
    models: matchedModels,
  };
  writeCatalogCache(cachePath, nextCache, fsImpl);
  return result("validated", {
    cachePath,
    checkedAt: currentTime,
    modelCount: matchedModels.length,
    appliedCount: applied.appliedCount,
    providerCount: applied.providerCount,
    sourceUrl,
  });
}

function findPiModelCatalogDataDirs(piWebUiRoot, fsImpl = fs) {
  const root = String(piWebUiRoot || "").trim();
  if (!root) return [];
  const candidates = [
    path.join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data"),
    path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data"),
  ];
  return [...new Set(candidates)].filter((candidate) => {
    try {
      return fsImpl.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
}

function parseRemotePiModelCatalog(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("pi_model_catalog_invalid_shape");
  }
  const models = [];
  for (const [providerId, providerValue] of Object.entries(payload)) {
    const entries = Array.isArray(providerValue)
      ? providerValue
      : providerValue && typeof providerValue === "object"
        ? Object.values(providerValue)
        : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const id = clean(entry.id, 512);
      const api = clean(entry.api, 128);
      const provider = clean(entry.provider || providerId, 128);
      const type = entry.type === undefined ? "chat" : clean(entry.type, 32);
      if (!id || !api || !provider || !MODEL_TYPES.has(type)) continue;
      models.push({...entry, id, api, provider, type});
    }
  }
  if (!models.length) throw new Error("pi_model_catalog_empty");
  const unique = new Map();
  for (const model of models) unique.set(`${model.provider}\0${model.type}\0${model.id}`, model);
  return [...unique.values()];
}

function applyCatalogModels(dataDirs, models, fsImpl = fs) {
  const catalogs = [];
  const providerRefs = new Map();
  const apiProviderRefs = new Map();
  for (const dataDir of dataDirs) {
    let files;
    try {
      files = fsImpl.readdirSync(dataDir).filter((file) => file.endsWith(".json") && file !== ".manifest.json");
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = path.join(dataDir, file);
      let catalog;
      try {
        catalog = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
      } catch {
        continue;
      }
      const providers = new Set();
      for (const apiModels of Object.values(catalog || {})) {
        if (!apiModels || typeof apiModels !== "object" || Array.isArray(apiModels)) continue;
        for (const model of Object.values(apiModels)) {
          if (model && typeof model.provider === "string") providers.add(model.provider);
        }
      }
      if (!providers.size) continue;
      const ref = {filePath, catalog, original: JSON.stringify(catalog), providers};
      catalogs.push(ref);
      for (const provider of providers) {
        const refs = providerRefs.get(provider) || [];
        refs.push(ref);
        providerRefs.set(provider, refs);
      }
      for (const [api, apiModels] of Object.entries(catalog || {})) {
        if (!apiModels || typeof apiModels !== "object" || Array.isArray(apiModels)) continue;
        const providersForApi = new Set(Object.values(apiModels).map((model) => model?.provider).filter(Boolean));
        if (!providersForApi.size) continue;
        const refs = apiProviderRefs.get(api) || [];
        refs.push({ref, providers: providersForApi});
        apiProviderRefs.set(api, refs);
      }
    }
  }

  let appliedCount = 0;
  const appliedProviders = new Set();
  const matchedModels = [];
  for (const model of models) {
    const providerMatch = resolveProviderRefs(model, providerRefs, apiProviderRefs);
    if (!providerMatch) continue;
    const {provider: targetProvider, refs} = providerMatch;
    const targetModel = targetProvider === model.provider ? model : {...model, provider: targetProvider};
    appliedProviders.add(targetProvider);
    matchedModels.push(model);
    for (const ref of refs) {
      const apiModels = ref.catalog[targetModel.api] || (ref.catalog[targetModel.api] = {});
      const previous = apiModels[targetModel.id];
      if (JSON.stringify(previous) === JSON.stringify(targetModel)) continue;
      apiModels[targetModel.id] = targetModel;
      appliedCount++;
    }
  }

  for (const ref of catalogs) {
    if (ref.original === JSON.stringify(ref.catalog)) continue;
    try {
      fsImpl.writeFileSync(ref.filePath, `${JSON.stringify(ref.catalog)}\n`, "utf8");
    } catch {
      // The cache still records a successful fetch. The next runner revision
      // can apply it when its package filesystem is writable.
    }
  }
  return {
    appliedCount,
    providerCount: appliedProviders.size,
    providers: appliedProviders,
    matchedModels,
  };
}

function resolveProviderRefs(model, providerRefs, apiProviderRefs) {
  const exact = providerRefs.get(model.provider);
  if (exact?.length) return {provider: model.provider, refs: exact};

  // Pi has renamed provider IDs while keeping the API adapter stable (for
  // example, hosted `azure` entries map to the pinned SDK's
  // `azure-openai-responses` provider). Only use an API fallback when that API
  // identifies one installed provider; never guess between shared adapters.
  const candidates = new Map();
  for (const {ref, providers} of apiProviderRefs.get(model.api) || []) {
    for (const provider of providers) candidates.set(provider, (candidates.get(provider) || []).concat(ref));
  }
  if (candidates.size !== 1) return null;
  const [provider, refs] = candidates.entries().next().value;
  if (!provider.startsWith(`${model.provider}-`) && !model.provider.startsWith(`${provider}-`)) return null;
  return {provider, refs: [...new Set(refs)]};
}

function readCatalogCache(cachePath, fsImpl = fs) {
  if (!cachePath) return null;
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(cachePath, "utf8"));
    if (!parsed || parsed.version !== MODEL_CATALOG_CACHE_VERSION || !Array.isArray(parsed.models)) return null;
    const models = parseRemotePiModelCatalog(parsed.models.reduce((groups, model) => {
      const provider = clean(model?.provider, 128);
      if (!provider) return groups;
      (groups[provider] ||= []).push(model);
      return groups;
    }, {}));
    return {...parsed, models};
  } catch {
    return null;
  }
}

function writeCatalogCache(cachePath, value, fsImpl = fs) {
  if (!cachePath) return;
  try {
    fsImpl.mkdirSync(path.dirname(cachePath), {recursive: true, mode: 0o700});
    const temporaryPath = `${cachePath}.${process.pid}.tmp`;
    fsImpl.writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, {encoding: "utf8", mode: 0o600});
    fsImpl.renameSync(temporaryPath, cachePath);
  } catch {
    // Catalog refresh is best effort; the running built-in catalog remains usable.
  }
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const parentSignal = options?.signal;
  const abort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener?.("abort", abort, {once: true});
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {...options, signal: controller.signal});
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener?.("abort", abort);
  }
}

function recordFailure({cache, cachePath, fsImpl, sourceUrl, now, error, appliedCache, logger}) {
  const checkedAt = Number(cache?.checkedAt || 0);
  const nextCache = cache ? {
    ...cache,
    sourceUrl,
    lastAttemptAt: now,
    lastError: String(error).slice(0, 240),
  } : {
    version: MODEL_CATALOG_CACHE_VERSION,
    sourceUrl,
    checkedAt: 0,
    lastAttemptAt: now,
    lastModified: 0,
    etag: null,
    lastError: String(error).slice(0, 240),
    models: [],
  };
  writeCatalogCache(cachePath, nextCache, fsImpl);
  logger.warn?.("Pi model catalog refresh failed; using cached/bundled models", {error: nextCache.lastError});
  return result(cache?.models?.length ? "stale" : "fallback", {
    cachePath,
    checkedAt,
    modelCount: cache?.models?.length || 0,
    appliedCount: appliedCache.appliedCount,
    providerCount: appliedCache.providerCount,
    sourceUrl,
    error: nextCache.lastError,
  });
}

function emptyApplyResult() {
  return {appliedCount: 0, providerCount: 0, providers: new Set()};
}

function result(status, details = {}) {
  return {status, ...details};
}

function parseLastModified(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : fallback;
}

function clean(value, maxLength) {
  const result = String(value ?? "").trim();
  return result && result.length <= maxLength ? result : "";
}

function safeError(error) {
  return String(error?.message || error || "unknown_error").replace(/\s+/g, "_").slice(0, 160);
}

module.exports = {
  DEFAULT_PI_MODEL_CATALOG_REFRESH_INTERVAL_MS,
  DEFAULT_PI_MODEL_CATALOG_TIMEOUT_MS,
  DEFAULT_PI_MODEL_CATALOG_URL,
  findPiModelCatalogDataDirs,
  parseRemotePiModelCatalog,
  refreshPiModelCatalog,
};
