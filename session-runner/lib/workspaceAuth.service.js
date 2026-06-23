"use strict";

const fs = require("fs");
const path = require("path");
const {compactErrorMessage} = require("./utils");
const {resolveHarnessMetadata} = require("./harnesses/metadata");

function createWorkspaceAuthService({admin, config, db}) {
  const harness = resolveHarnessMetadata(config);

  async function synchronizeAuth(options = {}) {
    if (!config.ownerUid || !harness.auth?.supported) return;
    const localAuth = await readLocalAuthFile();

    if (Object.keys(localAuth).length) {
      await writeRemoteAuthProviders(localAuth);
    }

    if (!options.materialize) return;

    const data = await readRemoteAuthData();
    const selection = await readSessionAuthSelection();
    const remoteAuth = buildMaterializedAuth(data, selection);
    if (!Object.keys(remoteAuth).length && !Object.keys(localAuth).length) return;

    const mergedAuth = selection && selection.harness === harness.id ? remoteAuth : {
      ...localAuth,
      ...remoteAuth,
    };
    await writeLocalAuthFile(mergedAuth);
    console.log(`${harness.id} auth materialized ${Object.keys(mergedAuth).length} provider(s) to ${authFilePath()}`);
  }

  async function readSessionAuthSelection() {
    if (!config.workspaceId || !config.sessionId) return null;
    try {
      const snap = await db.collection("workspaces").doc(config.workspaceId).collection("sessions").doc(config.sessionId).get();
      const data = snap.exists ? snap.data() : {};
      if (Object.prototype.hasOwnProperty.call(data, "authSelection")) {
        return normalizeAuthSelection(data.authSelection);
      }
      if (data.piAuthSelection && typeof data.piAuthSelection === "object" && !Array.isArray(data.piAuthSelection)) {
        return {
          harness: "pi",
          providers: normalizeAuthSelection(data.piAuthSelection).providers,
        };
      }
      return null;
    } catch (error) {
      console.warn("auth selection read failed", compactErrorMessage(error.message || error));
      return null;
    }
  }

  async function materializeAuthNow(selection = null) {
    if (!config.ownerUid || !harness.auth?.supported) {
      return {ok: true, appliedToRunner: false, providerCount: 0};
    }
    const data = await readRemoteAuthData();
    const auth = buildMaterializedAuth(data, selection === null ? await readSessionAuthSelection() : selection);
    await writeLocalAuthFile(auth);
    console.log(`${harness.id} auth materialized ${Object.keys(auth).length} selected provider(s) to ${authFilePath()}`);
    return {ok: true, appliedToRunner: true, providerCount: Object.keys(auth).length};
  }

  async function readRemoteAuthData() {
    const refs = compatibleAuthDocRefs(config.ownerUid, db);
    const [agentSnap, legacySnap] = await Promise.all([refs.agent.get(), refs.legacy.get()]);
    return mergeRemoteAuthData(
        agentSnap.exists ? agentSnap.data() : {},
        legacySnap.exists ? legacySnap.data() : {},
    );
  }

  async function writeRemoteAuthProviders(providers) {
    const refs = compatibleAuthDocRefs(config.ownerUid, db);
    const payload = {
      providers: normalizeAuthProviders(providers),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await Promise.all([
      refs.agent.set(payload, {merge: true}),
      refs.legacy.set(payload, {merge: true}),
    ]);
  }

  function buildMaterializedAuth(data, selection) {
    const providers = normalizeAuthProviders(data && data.providers);
    const entries = normalizeAuthEntries(data && data.entries, providers);
    const selectedProviders = normalizeAuthSelection(selection, entries);
    if (selectedProviders && selectedProviders.harness === harness.id) {
      return Object.entries(selectedProviders.providers).reduce((acc, [providerKey, entryId]) => {
        const entry = entries[entryId];
        if (entry && entry.providerKey === providerKey) acc[providerKey] = entry.credential;
        return acc;
      }, {});
    }
    return providersForHarness(providers, harness);
  }

  async function readLocalAuthFile() {
    const authPath = authFilePath();
    try {
      const content = await fs.promises.readFile(authPath, "utf8");
      if (harness.id === "codex") return normalizeAuthProviders(parseCodexAuthFile(content));
      return normalizeAuthProviders(JSON.parse(content));
    } catch (error) {
      if (error && error.code === "ENOENT") return {};
      console.warn(`${harness.id} auth read failed`, compactErrorMessage(error.message || error));
      return {};
    }
  }

  async function writeLocalAuthFile(auth) {
    const authPath = authFilePath();
    await fs.promises.mkdir(path.dirname(authPath), {recursive: true});
    if (harness.id === "codex") {
      const codexAuth = buildCodexAuthFile(auth);
      if (!codexAuth) {
        await fs.promises.unlink(authPath).catch((error) => {
          if (error && error.code !== "ENOENT") throw error;
        });
        return;
      }
      const content = JSON.stringify(codexAuth, null, 2);
      await fs.promises.writeFile(authPath, `${content}\n`, {mode: 0o600});
      await fs.promises.chmod(authPath, 0o600).catch(() => {});
      return;
    }
    const content = JSON.stringify(normalizeAuthProviders(auth), null, 2);
    await fs.promises.writeFile(authPath, `${content}\n`, {mode: 0o600});
    await fs.promises.chmod(authPath, 0o600).catch(() => {});
  }

  function authFilePath() {
    return harness.auth.storagePath(config);
  }

  return {
    buildMaterializedAuth,
    materializeAuthNow,
    normalizeAuthEntries,
    normalizeAuthProviders,
    normalizeAuthSelection,
    readLocalAuthFile,
    readSessionAuthSelection,
    synchronizeAuth,
    writeLocalAuthFile,
  };
}

function agentAuthDoc(uid, db) {
  return db.collection("users").doc(uid).collection("private").doc("agentAuth");
}

function legacyPiAuthDoc(uid, db) {
  return db.collection("users").doc(uid).collection("private").doc("piAuth");
}

function compatibleAuthDocRefs(uid, db) {
  return {
    agent: agentAuthDoc(uid, db),
    legacy: legacyPiAuthDoc(uid, db),
  };
}

function mergeRemoteAuthData(agentData = {}, legacyData = {}) {
  const legacyProviders = normalizeAuthProviders(legacyData.providers);
  const agentProviders = normalizeAuthProviders(agentData.providers);
  const providers = {...legacyProviders, ...agentProviders};
  const legacyEntries = normalizeAuthEntries(legacyData.entries, legacyProviders);
  const agentEntries = normalizeAuthEntries(agentData.entries, agentProviders);
  return {
    providers,
    entries: normalizeAuthEntries({...legacyEntries, ...agentEntries}, providers),
  };
}

function providersForHarness(providers, harness) {
  if (!harness.auth?.providerKeys || !Array.isArray(harness.auth.providerKeys)) return providers;
  return Object.entries(providers).reduce((acc, [providerKey, credential]) => {
    if (harness.auth.providerKeys.includes(providerKey)) acc[providerKey] = credential;
    return acc;
  }, {});
}

function parseCodexAuthFile(content) {
  try {
    const parsed = JSON.parse(String(content || "{}"));
    const providers = {};
    if (parsed.tokens && typeof parsed.tokens === "object") {
      providers["openai-codex"] = normalizePlainAuthObject({
        type: "oauth",
        id: parsed.tokens.id_token || "",
        access: parsed.tokens.access_token || "",
        refresh: parsed.tokens.refresh_token || "",
        accountId: parsed.tokens.account_id || "",
        lastRefresh: parsed.last_refresh || 0,
      });
    }
    if (parsed.OPENAI_API_KEY) {
      providers.openai = {type: "api_key", key: String(parsed.OPENAI_API_KEY)};
    }
    return providers;
  } catch (error) {
    return {};
  }
}

function buildCodexAuthFile(auth) {
  const providers = normalizeAuthProviders(auth);
  const oauth = normalizeCodexOauthCredential(providers["openai-codex"]);
  const apiKey = normalizeCodexApiKey(providers.openai);
  if (!oauth && !apiKey) return null;
  if (!oauth) {
    return {
      auth_mode: "apikey",
      OPENAI_API_KEY: apiKey,
    };
  }
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: apiKey || "",
    tokens: {
      id_token: oauth.id,
      access_token: oauth.access,
      refresh_token: oauth.refresh,
      account_id: oauth.accountId,
    },
    last_refresh: normalizeCodexLastRefresh(oauth.lastRefresh),
  };
}

function normalizeCodexApiKey(credential) {
  if (!credential || credential.type !== "api_key") return "";
  return String(credential.key || "").trim();
}

function normalizeCodexLastRefresh(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return null;
}

function normalizeCodexOauthCredential(credential) {
  if (!credential || credential.type !== "oauth") return null;
  const id = String(credential.id || "").trim();
  const access = String(credential.access || "").trim();
  const refresh = String(credential.refresh || "").trim();
  if (!looksLikeJwt(id) || !access || !refresh) return null;
  return {
    id,
    access,
    refresh,
    accountId: String(credential.accountId || "").trim(),
    lastRefresh: credential.lastRefresh ?? credential.expires ?? null,
  };
}

function looksLikeJwt(value) {
  const parts = String(value || "").trim().split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return false;
  return parts.slice(0, 2).every((part) => {
    try {
      const decoded = Buffer.from(part, "base64url").toString("utf8");
      const parsed = JSON.parse(decoded);
      return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed);
    } catch (error) {
      return false;
    }
  });
}

function normalizeAuthProviders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.entries(value).reduce((acc, [provider, credential]) => {
    const key = normalizeAuthKey(provider);
    if (!key || !credential || typeof credential !== "object" || Array.isArray(credential)) return acc;
    acc[key] = normalizePlainAuthObject(credential);
    return acc;
  }, {});
}

function normalizeAuthEntries(value, providers = {}) {
  const entries = value && typeof value === "object" && !Array.isArray(value) ?
    Object.entries(value).reduce((acc, [id, entry]) => {
      const normalizedId = normalizeAuthEntryId(id || entry && entry.id);
      if (!normalizedId || !entry || typeof entry !== "object" || Array.isArray(entry)) return acc;
      const providerKey = normalizeAuthKey(entry.providerKey || entry.provider || "");
      const credential = normalizePlainAuthObject(entry.credential || entry.value || {});
      if (!providerKey || !Object.keys(credential).length) return acc;
      acc[normalizedId] = {
        id: normalizedId,
        providerKey,
        label: normalizeAuthKey(entry.label || "") || providerKey,
        credential,
        createdAt: normalizeAuthKey(entry.createdAt || ""),
      };
      return acc;
    }, {}) :
    {};

  Object.entries(providers || {}).forEach(([providerKey, credential]) => {
    const hasProviderEntry = Object.values(entries).some((entry) => entry.providerKey === providerKey);
    if (!hasProviderEntry) {
      const id = `legacy-${providerKey}`;
      entries[id] = {
        id,
        providerKey,
        label: providerKey,
        credential: normalizePlainAuthObject(credential),
        createdAt: "",
      };
    }
  });
  return entries;
}

function normalizeAuthSelection(value, entries = null) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const harnessId = normalizeAuthKey(raw.harness || "");
  const selected = raw.providers && typeof raw.providers === "object" && !Array.isArray(raw.providers) ?
    raw.providers :
    raw;
  return {
    harness: harnessId,
    providers: Object.entries(selected).reduce((acc, [provider, entryId]) => {
      const providerKey = normalizeAuthKey(provider);
      const normalizedEntryId = normalizeAuthEntryId(entryId);
      if (!providerKey || !normalizedEntryId) return acc;
      if (entries) {
        const entry = entries[normalizedEntryId];
        if (entry && entry.providerKey === providerKey) acc[providerKey] = normalizedEntryId;
        return acc;
      }
      acc[providerKey] = normalizedEntryId;
      return acc;
    }, {}),
  };
}

function normalizeAuthEntryId(value) {
  const id = normalizeAuthKey(value);
  if (!id || id.length > 256 || /[^a-zA-Z0-9_.:-]/.test(id)) return "";
  return id;
}

function normalizePlainAuthObject(value) {
  return Object.entries(value || {}).reduce((acc, [key, item]) => {
    const cleanKey = normalizeAuthKey(key);
    if (!cleanKey) return acc;
    const normalized = normalizePlainAuthValue(item);
    if (normalized !== undefined) acc[cleanKey] = normalized;
    return acc;
  }, {});
}

function normalizePlainAuthValue(value) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) {
    return value.map(normalizePlainAuthValue).filter((entry) => entry !== undefined);
  }
  if (value && typeof value === "object") return normalizePlainAuthObject(value);
  return undefined;
}

function normalizeAuthKey(value) {
  return String(value || "").trim().slice(0, 256);
}

module.exports = {
  buildCodexAuthFile,
  createWorkspaceAuthService,
  mergeRemoteAuthData,
  normalizeAuthEntries,
  normalizeAuthProviders,
  normalizeAuthSelection,
  parseCodexAuthFile,
};
