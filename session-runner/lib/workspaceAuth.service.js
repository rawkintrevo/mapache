"use strict";

const fs = require("fs");
const path = require("path");
const {compactErrorMessage} = require("./utils");
const {resolveHarnessMetadata} = require("./harnesses/metadata");
const {ensurePrivateRuntimeDirectory} = require("./runtimeStorage.helpers");

function createWorkspaceAuthService({admin, config, db}) {
  const harness = resolveHarnessMetadata(config);

  async function synchronizeAuth(options = {}) {
    if (!config.ownerUid || !harness.auth?.supported) return;

    // The managed Pi runtime has a different credential owner: Firestore is
    // authoritative and the fixed agent directory is only a materialization
    // target.  In particular, never read a restored native auth file and copy
    // it back into Mapache's canonical credential document.
    if (isCanonicalAuthRuntime(config)) {
      if (!options.materialize) return {ok: true, appliedToRunner: false, providerCount: 0, secretFiles: secretFileInventory(config)};
      return materializeCanonicalAuth();
    }

    const localAuth = await readLocalAuthFile();

    if (Object.keys(localAuth).length) {
      await writeRemoteAuthProviders(localAuth);
    }

    if (!options.materialize) return;

    const data = await readRemoteAuthData();
    const selection = await readSessionAuthSelection();
    const remoteAuth = buildMaterializedAuth(data, selection);
    await writeGitHubCliAuth(remoteAuth);
    if (!Object.keys(remoteAuth).length && !Object.keys(localAuth).length) return;

    const mergedAuth = selection && selection.harness === harness.id ? remoteAuth : {
      ...localAuth,
      ...remoteAuth,
    };
    await writeLocalAuthFile(mergedAuth);
    console.log(`${harness.id} auth materialized ${Object.keys(mergedAuth).length} provider(s) to ${authFilePath()}`);
    return {ok: true, appliedToRunner: true, providerCount: Object.keys(mergedAuth).length, secretFiles: secretFileInventory(config)};
  }

  async function materializeCanonicalAuth(selectionOverride = null) {
    const data = await readRemoteAuthData();
    const selection = selectionOverride === null ? await readSessionAuthSelection() : selectionOverride;
    const auth = buildMaterializedAuth(data, selection);

    // provider-keys.json is an upstream key store.  It can contain a key from
    // an older restored UI state, so it must not survive into a managed boot
    // where Mapache's selected credentials are the only native auth source.
    await clearManagedCredentialShadowFiles();
    await writeGitHubCliAuth(auth);
    await writeLocalAuthFile(auth);
    console.log(`${harness.id} auth materialized ${Object.keys(auth).length} selected provider(s) to ${authFilePath()}`);
    return {ok: true, appliedToRunner: true, providerCount: Object.keys(auth).length, secretFiles: secretFileInventory(config)};
  }

  async function readSessionAuthSelection() {
    if (!config.workspaceId || !config.sessionId) return null;
    try {
      const snap = await db.collection("workspaces").doc(config.workspaceId).collection("sessions").doc(config.sessionId).get();
      const data = snap.exists ? snap.data() : {};
      if (Object.prototype.hasOwnProperty.call(data, "authSelection")) {
        return normalizeAuthSelection(data.authSelection);
      }
      return null;
    } catch (error) {
      console.warn("auth selection read failed", compactErrorMessage(error.message || error));
      return null;
    }
  }

  async function materializeAuthNow(selection = null) {
    if (!config.ownerUid || !harness.auth?.supported) {
      return {ok: true, appliedToRunner: false, providerCount: 0, secretFiles: secretFileInventory(config)};
    }
    if (isCanonicalAuthRuntime(config)) return materializeCanonicalAuth(selection);
    const data = await readRemoteAuthData();
    const auth = buildMaterializedAuth(data, selection === null ? await readSessionAuthSelection() : selection);
    await writeGitHubCliAuth(auth);
    await writeLocalAuthFile(auth);
    console.log(`${harness.id} auth materialized ${Object.keys(auth).length} selected provider(s) to ${authFilePath()}`);
    return {ok: true, appliedToRunner: true, providerCount: Object.keys(auth).length, secretFiles: secretFileInventory(config)};
  }

  async function clearManagedCredentialShadowFiles() {
    if (!isCanonicalAuthRuntime(config) || !config.piAgentDir) return;
    await fs.promises.unlink(path.join(config.piAgentDir, "provider-keys.json")).catch((error) => {
      if (error && error.code !== "ENOENT") throw error;
    });
  }

  async function readRemoteAuthData() {
    const snap = await agentAuthDoc(config.ownerUid, db).get();
    return mergeRemoteAuthData(snap.exists ? snap.data() : {});
  }

  async function writeRemoteAuthProviders(providers) {
    const payload = {
      providers: normalizeAuthProviders(providers),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await agentAuthDoc(config.ownerUid, db).set(payload, {merge: true});
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
      return normalizeAuthProviders(JSON.parse(content));
    } catch (error) {
      if (error && error.code === "ENOENT") return {};
      console.warn(`${harness.id} auth read failed`, compactErrorMessage(error.message || error));
      return {};
    }
  }

  async function writeLocalAuthFile(auth) {
    const authPath = authFilePath();
    const nativeAuth = authFileProviders(auth);
    if (config.isPrivateRuntime) await ensurePrivateRuntimeDirectory(path.dirname(authPath));
    await fs.promises.mkdir(path.dirname(authPath), {recursive: true});
    const content = JSON.stringify(normalizeAuthProviders(nativeAuth), null, 2);
    await fs.promises.writeFile(authPath, `${content}\n`, {mode: 0o600});
    await fs.promises.chmod(authPath, 0o600).catch(() => {});
  }

  async function writeGitHubCliAuth(auth) {
    const credential = normalizeGitHubCliCredential(auth && auth["github-cli"]);
    const hostsPath = githubCliHostsPath(config);
    if (!hostsPath) return;
    if (config.isPrivateRuntime) await ensurePrivateRuntimeDirectory(path.dirname(hostsPath));
    await fs.promises.mkdir(path.dirname(hostsPath), {recursive: true});
    if (!credential) {
      await fs.promises.unlink(hostsPath).catch((error) => {
        if (error && error.code !== "ENOENT") throw error;
      });
      return;
    }
    await fs.promises.writeFile(hostsPath, `${buildGitHubCliHostsYaml(credential)}\n`, {mode: 0o600});
    await fs.promises.chmod(hostsPath, 0o600).catch(() => {});
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
    secretFileInventory: () => secretFileInventory(config),
    synchronizeAuth,
    writeLocalAuthFile,
  };
}

function isManagedAgentRuntime(config = {}) {
  return config.agentRuntimeEnabled === true && resolveHarnessMetadata(config).id === "pi";
}

function isCanonicalAuthRuntime(config = {}) {
  return isManagedAgentRuntime(config) || config.isPrivateRuntime === true;
}

/**
 * Secret-bearing files known to the runner auth/materialization boundary.
 * The capture helper consumes this inventory later; it deliberately contains
 * paths and classifications only, never file contents or credential values.
 */
function secretFileInventory(config = {}) {
  const harness = resolveHarnessMetadata(config);
  const entries = [];
  const add = (id, localPath, kind, reason) => {
    if (!localPath) return;
    entries.push({id, localPath: path.resolve(localPath), kind, reason, capture: "exclude"});
  };

  if (harness.auth?.supported && typeof harness.auth.storagePath === "function") {
    add("agent-auth", harness.auth.storagePath(config), "credential", "native harness credentials are rematerialized from Mapache");
  }
  if (harness.id === "pi" && config.piAgentDir) {
    add("pi-provider-keys", path.join(config.piAgentDir, "provider-keys.json"), "credential", "upstream provider key store is not Mapache-owned");
    add("pi-model-config", path.join(config.piAgentDir, "models.json"), "secret-bearing-config", "custom provider keys or secret headers may be present");
    add("pi-mcp-oauth", path.join(config.piAgentDir, "mcp-oauth"), "connector-credential", "MCP OAuth state is materialized separately");
  }
  if (config.piMcpConfigPath) {
    add("pi-mcp-config", config.piMcpConfigPath, "secret-bearing-config", "generated MCP bindings are private Pi configuration");
  }
  add("github-cli-hosts", githubCliHostsPath(config), "credential", "GitHub CLI token is materialized from the Mapache provider");

  if (isManagedAgentRuntime(config) && config.homeDir) {
    const legacyAuth = path.join(config.homeDir, ".pi", "agent", "auth.json");
    const nativeAuth = harness.auth?.storagePath?.(config);
    if (path.resolve(legacyAuth) !== path.resolve(nativeAuth || "")) {
      add("legacy-pi-auth", legacyAuth, "legacy-credential", "restored home state must never become managed Pi input");
    }
  }
  return entries;
}

function authFileProviders(auth) {
  const providers = normalizeAuthProviders(auth);
  delete providers["github-cli"];
  return providers;
}

function githubCliHostsPath(config = {}) {
  const homeDir = config.homeDir ? path.resolve(config.homeDir) : "";
  if (!homeDir) return "";
  return path.join(homeDir, ".config", "gh", "hosts.yml");
}

function normalizeGitHubCliCredential(credential) {
  if (!credential || credential.type !== "api_key") return null;
  const token = String(credential.key || "").trim();
  if (!token) return null;
  return {
    host: String(credential.host || "github.com").trim() || "github.com",
    oauthToken: token,
    user: String(credential.user || "").trim(),
    gitProtocol: String(credential.gitProtocol || "https").trim() || "https",
  };
}

function yamlScalar(value) {
  const text = String(value || "");
  return JSON.stringify(text);
}

function buildGitHubCliHostsYaml(credential) {
  const host = credential.host || "github.com";
  const lines = [
    `${host}:`,
    `    oauth_token: ${yamlScalar(credential.oauthToken)}`,
    `    git_protocol: ${yamlScalar(credential.gitProtocol || "https")}`,
  ];
  if (credential.user) lines.push(`    user: ${yamlScalar(credential.user)}`);
  return lines.join("\n");
}

function agentAuthDoc(uid, db) {
  return db.collection("users").doc(uid).collection("private").doc("agentAuth");
}

function mergeRemoteAuthData(agentData = {}) {
  const providers = normalizeAuthProviders(agentData.providers);
  return {
    providers,
    entries: normalizeAuthEntries(agentData.entries, providers),
  };
}

function providersForHarness(providers, harness) {
  if (!harness.auth?.providerKeys || !Array.isArray(harness.auth.providerKeys)) return providers;
  return Object.entries(providers).reduce((acc, [providerKey, credential]) => {
    if (harness.auth.providerKeys.includes(providerKey)) acc[providerKey] = credential;
    return acc;
  }, {});
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
  authFileProviders,
  buildGitHubCliHostsYaml,
  createWorkspaceAuthService,
  githubCliHostsPath,
  isManagedAgentRuntime,
  mergeRemoteAuthData,
  normalizeGitHubCliCredential,
  normalizeAuthEntries,
  normalizeAuthProviders,
  normalizeAuthSelection,
  secretFileInventory,
};
