"use strict";

const crypto = require("crypto");
const {normalizeEnvironmentEntryIds} = require("./environmentKeys.service");
const {cleanName, httpError} = require("./backendUtils.helpers");

const PI_AUTH_API_KEY_PROVIDERS = new Set([
  "anthropic",
  "ant-ling",
  "azure-openai-responses",
  "openai",
  "github-cli",
  "deepseek",
  "nvidia",
  "google",
  "mistral",
  "groq",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "xai",
  "openrouter",
  "vercel-ai-gateway",
  "zai",
  "zai-coding-cn",
  "opencode",
  "opencode-go",
  "huggingface",
  "fireworks",
  "together",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
]);

function createAgentAuthService(dependencies = {}) {
  return {
    getPiAuth: (uid) => getPiAuth(uid, dependencies),
    savePiAuthProvider: (uid, provider, payload) => savePiAuthProvider(uid, provider, payload, dependencies),
    deletePiAuthProvider: (uid, provider) => deletePiAuthProvider(uid, provider, dependencies),
    deletePiAuthEntry: (uid, entryId) => deletePiAuthEntry(uid, entryId, dependencies),
    updatePiAuthCredential: (uid, entryId, providerKey, credential, label) =>
      updatePiAuthCredential(uid, entryId, providerKey, credential, label, dependencies),
    savePiAuthCredential: (uid, providerKey, credential, label) =>
      savePiAuthCredential(uid, providerKey, credential, label, dependencies),
    saveSessionPiAuthSelection: (uid, workspaceId, sessionId, payload) =>
      saveSessionPiAuthSelection(uid, workspaceId, sessionId, payload, dependencies),
  };
}

async function getPiAuth(uid, dependencies = {}) {
  const {providers, entries} = await readPiAuthState(uid, dependencies);
  return {providers, entries};
}

async function savePiAuthProvider(uid, provider, payload, dependencies = {}) {
  const providerKey = normalizePiAuthProviderKey(provider);
  const apiKey = normalizePiAuthApiKey(payload && payload.key);
  if (payload && payload.entryId) {
    await updatePiAuthCredential(
        uid,
        payload.entryId,
        providerKey,
        {type: "api_key", key: apiKey},
        payload.label,
        dependencies,
    );
  } else {
    await savePiAuthCredential(uid, providerKey, {type: "api_key", key: apiKey}, payload && payload.label, dependencies);
  }
  return getPiAuth(uid, dependencies);
}

async function deletePiAuthProvider(uid, provider, dependencies = {}) {
  const providerKey = normalizePiAuthStoredProviderKey(provider);
  const now = dependencies.admin.firestore.FieldValue.serverTimestamp();
  await dependencies.db.runTransaction(async (transaction) => {
    const state = await readPiAuthTransactionState(transaction, uid, dependencies);
    const nextAuth = removePiAuthProvider(state.providers, state.entries, providerKey);
    writePiAuthMaps(transaction, state.ref, state.snap, {
      providers: nextAuth.providers,
      entries: nextAuth.entries,
      updatedAt: now,
      createdAt: now,
    });
  });
  return getPiAuth(uid, dependencies);
}

async function deletePiAuthEntry(uid, entryId, dependencies = {}) {
  const normalizedEntryId = normalizePiAuthEntryId(entryId);
  const now = dependencies.admin.firestore.FieldValue.serverTimestamp();
  await dependencies.db.runTransaction(async (transaction) => {
    const state = await readPiAuthTransactionState(transaction, uid, dependencies);
    const nextAuth = removePiAuthEntry(state.providers, state.entries, normalizedEntryId);
    if (!nextAuth) return;
    writePiAuthMaps(transaction, state.ref, state.snap, {
      providers: nextAuth.providers,
      entries: nextAuth.entries,
      updatedAt: now,
      createdAt: now,
    });
  });
  return getPiAuth(uid, dependencies);
}

async function savePiAuthCredential(uid, providerKey, credential, label = "", dependencies = {}) {
  const now = dependencies.admin.firestore.FieldValue.serverTimestamp();
  await dependencies.db.runTransaction(async (transaction) => {
    const state = await readPiAuthTransactionState(transaction, uid, dependencies);
    const cleanCredential = normalizePlainObject(credential);
    const entryId = buildPiAuthEntryId(providerKey);
    const createdAt = new Date().toISOString();
    writePiAuthMaps(transaction, state.ref, state.snap, {
      providers: {
        ...state.providers,
        [providerKey]: cleanCredential,
      },
      entries: {
        ...state.entries,
        [entryId]: {
          id: entryId,
          providerKey,
          label: cleanName(label) || defaultPiAuthEntryLabel(providerKey, state.entries),
          credential: cleanCredential,
          createdAt,
        },
      },
      updatedAt: now,
      createdAt: now,
    });
  });
}

async function updatePiAuthCredential(uid, entryId, providerKey, credential, label = "", dependencies = {}) {
  const normalizedEntryId = normalizePiAuthEntryId(entryId);
  const normalizedProviderKey = normalizePiAuthStoredProviderKey(providerKey);
  const now = dependencies.admin.firestore.FieldValue.serverTimestamp();
  await dependencies.db.runTransaction(async (transaction) => {
    const state = await readPiAuthTransactionState(transaction, uid, dependencies);
    const current = state.entries[normalizedEntryId];
    if (!current || current.providerKey !== normalizedProviderKey) {
      throw httpError(404, "pi_auth_entry_not_found");
    }
    const cleanCredential = normalizePlainObject(credential);
    writePiAuthMaps(transaction, state.ref, state.snap, {
      providers: {
        ...state.providers,
        [normalizedProviderKey]: cleanCredential,
      },
      entries: {
        ...state.entries,
        [normalizedEntryId]: {
          ...current,
          label: cleanName(label) || current.label,
          credential: cleanCredential,
          updatedAt: new Date().toISOString(),
        },
      },
      updatedAt: now,
      createdAt: now,
    });
  });
}

async function saveSessionPiAuthSelection(uid, workspaceId, sessionId, payload, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const harnessId = sessionHarnessId(session);
  const hasEnvironmentSelection = Array.isArray(payload?.environmentEntryIds);
  const environmentEntryIds = hasEnvironmentSelection ?
    normalizeEnvironmentEntryIds(payload.environmentEntryIds) :
    normalizeEnvironmentEntryIds(session.environmentEntryIds || session.genericEnvironmentEntryIds || []);
  if (!["pi", "codex"].includes(harnessId) && !hasEnvironmentSelection) {
    throw httpError(400, "auth_selection_unsupported");
  }
  const piAuth = ["pi", "codex"].includes(harnessId) ? await getPiAuth(uid, dependencies) : {entries: {}};
  const selection = {
    harness: harnessId,
    providers: normalizePiAuthSelection(
        payload && payload.selection && payload.selection.providers ? payload.selection.providers : payload && payload.selection,
        piAuth.entries,
    ),
  };
  await sessionSnap.ref.set({
    authSelection: selection,
    environmentEntryIds,
    authSelectionUpdatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});

  let materialized = {
    ok: true,
    appliedToRunner: false,
    providerCount: Object.keys(selection.providers).length,
    environmentCount: environmentEntryIds.length,
  };
  if (session.serviceUrl && session.shutdownToken) {
    materialized = await requestRunnerAuthMaterialize(session, {selection, environmentEntryIds}, dependencies);
  }
  return {ok: true, selection, materialized};
}

async function requestRunnerAuthMaterialize(session, body, dependencies = {}) {
  if (typeof dependencies.requestRunnerJson !== "function") {
    throw new Error("Agent auth service requires a requestRunnerJson dependency.");
  }
  return dependencies.requestRunnerJson(session, "/auth/materialize", {
    method: "POST",
    body,
    notFoundError: "runner_auth_unsupported",
    notFoundStatus: 501,
    failureError: "auth_materialize_failed",
    unavailableError: "runner_auth_unavailable",
    timeoutMs: 30000,
  });
}

function agentAuthDoc(uid, dependencies = {}) {
  return dependencies.db.collection("users").doc(uid).collection("private").doc("agentAuth");
}

async function readPiAuthState(uid, dependencies = {}) {
  const snap = await agentAuthDoc(uid, dependencies).get();
  return normalizePiAuthState(snap.exists ? snap.data() : {});
}

async function readPiAuthTransactionState(transaction, uid, dependencies = {}) {
  const ref = agentAuthDoc(uid, dependencies);
  const snap = await transaction.get(ref);
  return {
    ref,
    snap,
    ...normalizePiAuthState(snap.exists ? snap.data() : {}),
  };
}

function normalizePiAuthState(data = {}) {
  const providers = normalizePiAuthProviders(data.providers);
  return {
    providers,
    entries: normalizePiAuthEntries(data.entries, providers),
  };
}

function writePiAuthMaps(transaction, ref, snap, fields) {
  const payload = {
    providers: fields.providers,
    entries: fields.entries,
    updatedAt: fields.updatedAt,
  };
  if (snap.exists) {
    transaction.update(ref, payload);
    return;
  }
  transaction.set(ref, {...payload, createdAt: fields.createdAt});
}

function normalizePiAuthProviders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.entries(value).reduce((acc, [provider, credential]) => {
    const key = cleanName(provider);
    if (!key || !credential || typeof credential !== "object" || Array.isArray(credential)) return acc;
    acc[key] = normalizePlainObject(credential);
    return acc;
  }, {});
}

function normalizePiAuthEntries(value, providers = {}) {
  const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value).reduce((acc, [id, entry]) => {
    const normalizedId = normalizePiAuthEntryId(id || entry && entry.id, {required: false});
    if (!normalizedId || !entry || typeof entry !== "object" || Array.isArray(entry)) return acc;
    const providerKey = normalizePiAuthStoredProviderKey(entry.providerKey || entry.provider || "");
    const credential = normalizePlainObject(entry.credential || entry.value || {});
    if (!providerKey || !Object.keys(credential).length) return acc;
    acc[normalizedId] = {
      id: normalizedId,
      providerKey,
      label: cleanName(entry.label || "") || piAuthProviderEntryFallbackLabel(providerKey),
      credential,
      createdAt: cleanName(entry.createdAt || ""),
    };
    return acc;
  }, {}) : {};

  Object.entries(providers || {}).forEach(([providerKey, credential]) => {
    const hasProviderEntry = Object.values(entries).some((entry) => entry.providerKey === providerKey);
    if (!hasProviderEntry) {
      const id = `legacy-${providerKey}`;
      entries[id] = {
        id,
        providerKey,
        label: piAuthProviderEntryFallbackLabel(providerKey),
        credential: normalizePlainObject(credential),
        createdAt: "",
      };
    }
  });
  return entries;
}

function normalizePiAuthSelection(value, entries = {}) {
  const selected = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.entries(selected).reduce((acc, [provider, entryId]) => {
    const providerKey = normalizePiAuthStoredProviderKey(provider);
    const normalizedEntryId = normalizePiAuthEntryId(entryId, {required: false});
    const entry = entries[normalizedEntryId];
    if (providerKey && entry && entry.providerKey === providerKey) acc[providerKey] = normalizedEntryId;
    return acc;
  }, {});
}

function normalizePiAuthEntryId(value, options = {}) {
  const id = cleanName(value);
  if (!id && options.required === false) return "";
  if (!id || id.length > 256 || /[^a-zA-Z0-9_.:-]/.test(id)) {
    throw httpError(400, "invalid_pi_auth_entry");
  }
  return id;
}

function normalizePiAuthProviderKey(value) {
  const provider = normalizePiAuthStoredProviderKey(value);
  if (!PI_AUTH_API_KEY_PROVIDERS.has(provider)) {
    throw httpError(400, "invalid_pi_auth_provider");
  }
  return provider;
}

function normalizePiAuthStoredProviderKey(value) {
  const provider = cleanName(value);
  if (!provider || provider.length > 256 || /[\u0000-\u001f\u007f]/.test(provider)) {
    throw httpError(400, "invalid_pi_auth_provider");
  }
  return provider;
}

function normalizePiAuthApiKey(value) {
  const key = String(value || "").trim();
  if (!key || /[\u0000-\u001f\u007f]/.test(key) || key.length > 4096) {
    throw httpError(400, "invalid_pi_auth_key");
  }
  return key;
}

function normalizePlainObject(value) {
  return Object.entries(value || {}).reduce((acc, [key, item]) => {
    const cleanKey = cleanName(key);
    if (!cleanKey) return acc;
    const normalized = normalizePlainValue(item);
    if (normalized !== undefined) acc[cleanKey] = normalized;
    return acc;
  }, {});
}

function normalizePlainValue(value) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(normalizePlainValue).filter((entry) => entry !== undefined);
  if (value && typeof value === "object") return normalizePlainObject(value);
  return undefined;
}

function removePiAuthProvider(providers, entries, providerKey) {
  const nextProviders = {...providers};
  delete nextProviders[providerKey];
  const nextEntries = Object.entries(entries).reduce((acc, [id, entry]) => {
    if (entry.providerKey !== providerKey) acc[id] = entry;
    return acc;
  }, {});
  return {providers: nextProviders, entries: nextEntries};
}

function removePiAuthEntry(providers, entries, entryId) {
  const entry = entries[entryId];
  if (!entry) return null;
  const nextEntries = {...entries};
  delete nextEntries[entryId];
  const latestForProvider = Object.values(nextEntries)
      .filter((item) => item.providerKey === entry.providerKey)
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))[0];
  const nextProviders = {...providers};
  if (latestForProvider) nextProviders[entry.providerKey] = latestForProvider.credential;
  else delete nextProviders[entry.providerKey];
  return {providers: nextProviders, entries: nextEntries};
}

function buildPiAuthEntryId(providerKey) {
  return `${providerKey}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function defaultPiAuthEntryLabel(providerKey, entries) {
  const count = Object.values(entries || {}).filter((entry) => entry.providerKey === providerKey).length + 1;
  return count > 1 ? `${piAuthProviderEntryFallbackLabel(providerKey)} ${count}` : piAuthProviderEntryFallbackLabel(providerKey);
}

function piAuthProviderEntryFallbackLabel(providerKey) {
  return providerKey;
}

function sessionHarnessId(session = {}) {
  const harnessId = String(session.harnessId || "").trim().toLowerCase();
  if (harnessId) return harnessId;
  const terminalKind = String(session.terminalKind || "").trim().toLowerCase();
  if (terminalKind) return terminalKind;
  const imageKey = String(session.imageKey || "").trim().toLowerCase();
  if (imageKey.startsWith("pi-")) return "pi";
  if (imageKey.startsWith("codex-")) return "codex";
  const image = String(session.image || "").trim().toLowerCase();
  if (/session-runner:pi-/.test(image)) return "pi";
  if (/session-runner:codex-/.test(image)) return "codex";
  return "shell";
}

async function requireWorkspaceDependency(dependencies, uid, workspaceId) {
  if (typeof dependencies.requireWorkspace !== "function") {
    throw new Error("Agent auth service requires a requireWorkspace dependency.");
  }
  return dependencies.requireWorkspace(uid, workspaceId);
}

async function requireSessionDependency(dependencies, uid, workspaceId, sessionId) {
  if (typeof dependencies.requireSession !== "function") {
    throw new Error("Agent auth service requires a requireSession dependency.");
  }
  return dependencies.requireSession(uid, workspaceId, sessionId);
}

module.exports = {
  createAgentAuthService,
  normalizePiAuthApiKey,
  normalizePiAuthEntries,
  normalizePiAuthEntryId,
  normalizePiAuthProviderKey,
  normalizePiAuthProviders,
  normalizePiAuthSelection,
  normalizePiAuthStoredProviderKey,
  normalizePlainObject,
  removePiAuthEntry,
  removePiAuthProvider,
  sessionHarnessId,
  writePiAuthMaps,
};
