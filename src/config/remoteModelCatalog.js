import bundledCatalog from "./automationModelCatalog.json";

export const PI_MODEL_CATALOG_URL = "https://pi.dev/api/models?types=chat%2Cimage%2Cclassifier";
export const PI_MODEL_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
const PI_MODEL_CATALOG_STORAGE_KEY = "mapache.pi-model-catalog.v1";

let cachedCatalog = null;
let cachedAt = 0;
let refreshPromise = null;

/**
 * Convert Pi's provider-array response into the small label catalog used by
 * the automation editor. The bundled provider set is the compatibility
 * boundary: unknown providers are left to Pi's runtime/custom-ID path rather
 * than presented as selectable automations that the runner cannot register.
 */
export function normalizeRemoteModelCatalog(payload, baseCatalog = bundledCatalog) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invalid_model_catalog_shape");
  }
  const providers = Object.fromEntries(Object.entries(baseCatalog?.providers || {}).map(([provider, models]) => [provider, {...models}]));
  let modelCount = 0;
  for (const [remoteProviderId, providerValue] of Object.entries(payload)) {
    const providerId = resolveProviderId(remoteProviderId, providers);
    if (!providerId) continue;
    const entries = Array.isArray(providerValue)
      ? providerValue
      : providerValue && typeof providerValue === "object"
        ? Object.values(providerValue)
        : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      if (entry.type !== undefined && entry.type !== "chat") continue;
      const id = clean(entry.id, 512);
      if (!id) continue;
      const name = clean(entry.name || entry.label || id, 256) || id;
      if (!providers[providerId][id]) modelCount++;
      providers[providerId][id] = name;
    }
  }
  if (!modelCount && !Object.keys(providers).length) throw new Error("invalid_model_catalog_empty");
  return {
    providers,
    source: {
      ...(baseCatalog?.source || {}),
      url: PI_MODEL_CATALOG_URL,
      refreshedAt: Date.now(),
      remote: true,
    },
  };
}

function resolveProviderId(remoteProviderId, providers) {
  if (Object.prototype.hasOwnProperty.call(providers, remoteProviderId)) return remoteProviderId;
  const aliases = Object.keys(providers).filter((providerId) =>
    providerId.startsWith(`${remoteProviderId}-`) && providerId.endsWith("-responses"));
  return aliases.length === 1 ? aliases[0] : "";
}

export async function loadRemoteModelCatalog({fetchImpl = globalThis.fetch, force = false, now = () => Date.now()} = {}) {
  const currentTime = Number(now());
  if (!cachedCatalog) {
    const stored = readStoredCatalog();
    if (stored) {
      cachedCatalog = stored.catalog;
      cachedAt = stored.checkedAt;
    }
  }
  if (!force && cachedCatalog && currentTime - cachedAt < PI_MODEL_CATALOG_REFRESH_INTERVAL_MS) return cachedCatalog;
  if (!force && refreshPromise) return refreshPromise;
  if (typeof fetchImpl !== "function") throw new Error("model_catalog_fetch_unavailable");

  refreshPromise = (async () => {
    try {
      const response = await fetchImpl(PI_MODEL_CATALOG_URL, {headers: {accept: "application/json"}});
      if (!response?.ok) throw new Error(`model_catalog_http_${response?.status || "unavailable"}`);
      const catalog = normalizeRemoteModelCatalog(await response.json());
      const lastModified = response.headers?.get?.("last-modified");
      const revision = response.headers?.get?.("x-pi-model-catalog-revision");
      catalog.source = {
        ...catalog.source,
        ...(lastModified ? {lastModified} : {}),
        ...(revision ? {revision} : {}),
      };
      cachedCatalog = catalog;
      cachedAt = Number(now());
      writeStoredCatalog({catalog, checkedAt: cachedAt});
      return catalog;
    } catch (error) {
      // A stale persisted catalog is still more useful than dropping newly
      // discovered models back to the old checked-in fallback after a reload.
      if (cachedCatalog) return cachedCatalog;
      throw error;
    }
  })();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

export function bundledModelCatalog() {
  return bundledCatalog;
}

function clean(value, maxLength) {
  const result = String(value ?? "").trim();
  return result && result.length <= maxLength ? result : "";
}

function readStoredCatalog() {
  try {
    const value = globalThis.localStorage?.getItem(PI_MODEL_CATALOG_STORAGE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value);
    const checkedAt = Number(parsed?.checkedAt);
    const providers = parsed?.catalog?.providers;
    if (!Number.isFinite(checkedAt) || !providers || typeof providers !== "object" || Array.isArray(providers)) return null;
    if (Object.values(providers).some((models) =>
      !models || typeof models !== "object" || Array.isArray(models) ||
      Object.entries(models).some(([id, name]) => !clean(id, 512) || !clean(name, 256)))) return null;
    return {catalog: parsed.catalog, checkedAt};
  } catch {
    return null;
  }
}

function writeStoredCatalog(value) {
  try {
    globalThis.localStorage?.setItem(PI_MODEL_CATALOG_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Private browsing and strict storage policies leave the in-memory cache usable.
  }
}
