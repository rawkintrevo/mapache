"use strict";

const fs = require("fs");
const path = require("path");
const {compactErrorMessage} = require("./utils");

function createWorkspacePiAuthService({admin, config, db}) {
  async function synchronizePiAuth(options = {}) {
    if (!config.ownerUid) return;
    const ref = db.collection("users").doc(config.ownerUid).collection("private").doc("piAuth");
    const localAuth = await readPiAuthFile();

    if (Object.keys(localAuth).length) {
      await ref.set({
        providers: localAuth,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
    }

    if (!options.materialize) return;

    const snap = await ref.get();
    const data = snap.exists ? snap.data() : {};
    const selection = await readSessionPiAuthSelection();
    const remoteAuth = buildMaterializedPiAuth(data, selection);
    if (!Object.keys(remoteAuth).length && !Object.keys(localAuth).length) return;

    const mergedAuth = selection ? remoteAuth : {
      ...localAuth,
      ...remoteAuth,
    };
    await writePiAuthFile(mergedAuth);
    console.log(`pi auth materialized ${Object.keys(mergedAuth).length} provider(s) to ${piAuthFilePath()}`);
  }

  async function readSessionPiAuthSelection() {
    if (!config.workspaceId || !config.sessionId) return null;
    try {
      const snap = await db.collection("workspaces").doc(config.workspaceId).collection("sessions").doc(config.sessionId).get();
      const data = snap.exists ? snap.data() : {};
      if (!Object.prototype.hasOwnProperty.call(data, "piAuthSelection")) return null;
      return normalizePiAuthSelection(data.piAuthSelection);
    } catch (error) {
      console.warn("pi auth selection read failed", compactErrorMessage(error.message || error));
      return null;
    }
  }

  async function materializePiAuthNow(selection = null) {
    const ref = db.collection("users").doc(config.ownerUid).collection("private").doc("piAuth");
    const snap = await ref.get();
    const data = snap.exists ? snap.data() : {};
    const auth = buildMaterializedPiAuth(data, selection === null ? await readSessionPiAuthSelection() : selection);
    await writePiAuthFile(auth);
    console.log(`pi auth materialized ${Object.keys(auth).length} selected provider(s) to ${piAuthFilePath()}`);
    return {ok: true, appliedToRunner: true, providerCount: Object.keys(auth).length};
  }

  function buildMaterializedPiAuth(data, selection) {
    const providers = normalizePiAuthProviders(data && data.providers);
    const entries = normalizePiAuthEntries(data && data.entries, providers);
    if (selection && typeof selection === "object") {
      const normalizedSelection = normalizePiAuthSelection(selection, entries);
      return Object.entries(normalizedSelection).reduce((acc, [providerKey, entryId]) => {
        const entry = entries[entryId];
        if (entry && entry.providerKey === providerKey) acc[providerKey] = entry.credential;
        return acc;
      }, {});
    }
    return providers;
  }

  async function readPiAuthFile() {
    const authPath = piAuthFilePath();
    try {
      const content = await fs.promises.readFile(authPath, "utf8");
      return normalizePiAuthProviders(JSON.parse(content));
    } catch (error) {
      if (error && error.code === "ENOENT") return {};
      console.warn("pi auth read failed", compactErrorMessage(error.message || error));
      return {};
    }
  }

  async function writePiAuthFile(auth) {
    const authPath = piAuthFilePath();
    await fs.promises.mkdir(path.dirname(authPath), {recursive: true});
    await fs.promises.writeFile(authPath, `${JSON.stringify(normalizePiAuthProviders(auth), null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.promises.chmod(authPath, 0o600).catch(() => {});
  }

  function piAuthFilePath() {
    return path.join(config.piAgentDir, "auth.json");
  }

  return {
    buildMaterializedPiAuth,
    materializePiAuthNow,
    normalizePiAuthEntries,
    normalizePiAuthProviders,
    normalizePiAuthSelection,
    readPiAuthFile,
    readSessionPiAuthSelection,
    synchronizePiAuth,
    writePiAuthFile,
  };
}

function normalizePiAuthProviders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.entries(value).reduce((acc, [provider, credential]) => {
    const key = normalizeAuthKey(provider);
    if (!key || !credential || typeof credential !== "object" || Array.isArray(credential)) return acc;
    acc[key] = normalizePlainAuthObject(credential);
    return acc;
  }, {});
}

function normalizePiAuthEntries(value, providers = {}) {
  const entries = value && typeof value === "object" && !Array.isArray(value) ?
    Object.entries(value).reduce((acc, [id, entry]) => {
      const normalizedId = normalizePiAuthEntryId(id || entry && entry.id);
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

function normalizePiAuthSelection(value, entries = null) {
  const selected = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.entries(selected).reduce((acc, [provider, entryId]) => {
    const providerKey = normalizeAuthKey(provider);
    const normalizedEntryId = normalizePiAuthEntryId(entryId);
    if (!providerKey || !normalizedEntryId) return acc;
    if (entries) {
      const entry = entries[normalizedEntryId];
      if (entry && entry.providerKey === providerKey) acc[providerKey] = normalizedEntryId;
      return acc;
    }
    acc[providerKey] = normalizedEntryId;
    return acc;
  }, {});
}

function normalizePiAuthEntryId(value) {
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
  createWorkspacePiAuthService,
  normalizePiAuthEntries,
  normalizePiAuthProviders,
  normalizePiAuthSelection,
};
