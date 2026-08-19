"use strict";

const logger = require("firebase-functions/logger");
const {cleanName, httpError, normalizeStoragePrefix} = require("./backendUtils.helpers");

function createPiPackagesService(dependencies = {}) {
  return {
    installPiPackage: (uid, workspaceId, sessionId, payload) =>
      installPiPackage(uid, workspaceId, sessionId, payload, dependencies),
    listPiPackages: (uid, workspaceId, sessionId) => listPiPackages(uid, workspaceId, sessionId, dependencies),
    removePiPackage: (uid, workspaceId, sessionId, payload) =>
      removePiPackage(uid, workspaceId, sessionId, payload, dependencies),
    updatePiPackage: (uid, workspaceId, sessionId, payload) =>
      updatePiPackage(uid, workspaceId, sessionId, payload, dependencies),
    mergePiPackageCatalogEntry: (uid, workspaceId, source, options) =>
      mergePiPackageCatalogEntry(uid, workspaceId, source, options, dependencies),
  };
}

async function installPiPackage(uid, workspaceId, sessionId, payload, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const packageSource = normalizePiPackageSource(payload.source);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_package_install_unsupported");
  const result = await requestRunnerPiPackageInstall(session, {source: packageSource.source}, dependencies);
  await mergeInstalledPiPackageCatalogEntry(uid, workspaceId, packageSource.source, dependencies);
  return result;
}

async function removePiPackage(uid, workspaceId, sessionId, payload, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const packageSource = normalizePiPackageSource(payload.source);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_package_remove_unsupported");
  return requestRunnerPiPackageRemove(session, {source: packageSource.source}, dependencies);
}

async function updatePiPackage(uid, workspaceId, sessionId, payload, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const packageSource = payload.source ? normalizePiPackageSource(payload.source) : null;
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_package_update_unsupported");
  return requestRunnerPiPackageUpdate(session, packageSource ? {source: packageSource.source} : {}, dependencies);
}

async function listPiPackages(uid, workspaceId, sessionId, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_package_listing_unsupported");
  const data = await requestRunnerPiPackages(session, dependencies);
  await recordObservedPiPackages(uid, workspaceId, data, dependencies).catch((error) => {
    logger.warn("observed package catalog update failed", {workspaceId, sessionId, error: error.message || error});
  });
  const knownPackages = await listKnownPiPackages(uid, data, dependencies).catch((error) => {
    logger.warn("known package catalog read failed", {workspaceId, sessionId, error: error.message || error});
    return [];
  });
  return {...data, knownPackages};
}

async function listKnownPiPackages(uid, data, dependencies = {}) {
  const configuredSources = new Set((data && Array.isArray(data.packages) ? data.packages : [])
      .map((packageInfo) => packageInfo && packageInfo.source)
      .filter(Boolean));
  const snap = await piPackageCatalogCollection(uid, dependencies).get();
  return snap.docs
      .map((doc) => ({id: doc.id, ...doc.data()}))
      .filter((packageInfo) => packageInfo.source && !configuredSources.has(packageInfo.source))
      .map((packageInfo) => ({
        source: packageInfo.source,
        identity: packageInfo.identity || "",
        type: packageInfo.type || "",
        favorite: Boolean(packageInfo.favorite),
        lastWorkspaceId: packageInfo.lastWorkspaceId || "",
        installCount: Number(packageInfo.installCount || 0),
      }))
      .sort((left, right) => left.source.localeCompare(right.source));
}

async function recordObservedPiPackages(uid, workspaceId, data, dependencies = {}) {
  const packages = data && Array.isArray(data.packages) ? data.packages : [];
  const results = await Promise.allSettled(packages.map((packageInfo) => (
    mergeObservedPiPackageCatalogEntry(uid, workspaceId, packageInfo && packageInfo.source, dependencies)
  )));
  results
      .filter((result) => result.status === "rejected")
      .forEach((result) => logger.warn("skipped observed package catalog entry", {
        workspaceId,
        error: result.reason && result.reason.message ? result.reason.message : result.reason,
      }));
}

async function mergeObservedPiPackageCatalogEntry(uid, workspaceId, source, dependencies = {}) {
  if (!source) return null;
  const normalized = normalizePiPackageSource(source);
  const ref = piPackageCatalogCollection(uid, dependencies).doc(piPackageCatalogDocId(normalized.identity));
  await dependencies.db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    transaction.set(ref, piPackageCatalogRecord(source, workspaceId, {includeCreatedAt: !snap.exists}, dependencies), {merge: true});
  });
  return normalized;
}

async function mergeInstalledPiPackageCatalogEntry(uid, workspaceId, source, dependencies = {}) {
  const normalized = normalizePiPackageSource(source);
  const ref = piPackageCatalogCollection(uid, dependencies).doc(piPackageCatalogDocId(normalized.identity));
  await dependencies.db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    transaction.set(ref, piPackageCatalogRecord(source, workspaceId, {
      includeCreatedAt: !snap.exists,
      incrementInstallCount: true,
    }, dependencies), {merge: true});
  });
}

async function mergePiPackageCatalogEntry(uid, workspaceId, source, options = {}, dependencies = {}) {
  const record = piPackageCatalogRecord(source, workspaceId, options, dependencies);
  await piPackageCatalogCollection(uid, dependencies).doc(piPackageCatalogDocId(record.identity)).set(record, {merge: true});
  return record;
}

async function requestRunnerPiPackages(session, dependencies = {}) {
  return requestRunnerJsonDependency(dependencies, session, "/pi/packages", {
    notFoundError: "runner_package_listing_unsupported",
    notFoundStatus: 501,
    failureError: "pi_package_read_failed",
    unavailableError: "runner_package_list_unavailable",
  });
}

async function requestRunnerPiPackageInstall(session, body, dependencies = {}) {
  return requestRunnerJsonDependency(dependencies, session, "/pi/packages/install", {
    method: "POST",
    body,
    notFoundError: "runner_package_install_unsupported",
    notFoundStatus: 501,
    failureError: "pi_package_install_failed",
    unavailableError: "runner_package_install_unavailable",
    timeoutMs: 120000,
  });
}

async function requestRunnerPiPackageRemove(session, body, dependencies = {}) {
  return requestRunnerJsonDependency(dependencies, session, "/pi/packages/remove", {
    method: "POST",
    body,
    notFoundError: "runner_package_remove_unsupported",
    notFoundStatus: 501,
    failureError: "pi_package_remove_failed",
    unavailableError: "runner_package_remove_unavailable",
    timeoutMs: 120000,
  });
}

async function requestRunnerPiPackageUpdate(session, body, dependencies = {}) {
  return requestRunnerJsonDependency(dependencies, session, "/pi/packages/update", {
    method: "POST",
    body,
    notFoundError: "runner_package_update_unsupported",
    notFoundStatus: 501,
    failureError: "pi_package_update_failed",
    unavailableError: "runner_package_update_unavailable",
    timeoutMs: 120000,
  });
}

function normalizePiPackageSource(value) {
  const source = String(value || "").trim();
  if (!source || /[\u0000-\u001f\u007f]/.test(source)) throw httpError(400, "invalid_package_source");
  if (source.startsWith("npm:")) return normalizeNpmPackageSource(source);
  const gitSource = normalizeGitPackageSource(source);
  if (gitSource) return gitSource;
  throw httpError(400, "unsupported_package_source");
}

function normalizeNpmPackageSource(source) {
  const spec = source.slice("npm:".length).trim();
  const match = spec.match(/^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@([^\s/]+))?$/i);
  if (!match) throw httpError(400, "invalid_package_source");
  const name = match[1].toLowerCase();
  return {source, type: "npm", identity: `npm:${name}`, name, pinned: Boolean(match[2])};
}

function normalizeGitPackageSource(source) {
  const parsed = parseGitPackageSource(source);
  if (!parsed) return null;
  return {source, type: "git", identity: `git:${parsed.host}/${parsed.path}`, host: parsed.host, path: parsed.path, pinned: Boolean(parsed.ref)};
}

function parseGitPackageSource(source) {
  const withoutGitPrefix = source.startsWith("git:") ? source.slice("git:".length) : source;
  const withoutGitPlus = withoutGitPrefix.startsWith("git+") ? withoutGitPrefix.slice("git+".length) : withoutGitPrefix;
  const [withoutRef, ref = ""] = withoutGitPlus.split("#");
  const sshMatch = withoutRef.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) return buildGitPackageSource(sshMatch[1], sshMatch[2], ref);
  const githubShorthand = withoutRef.match(/^github:([^/]+\/.+)$/);
  if (githubShorthand) return buildGitPackageSource("github.com", githubShorthand[1], ref);
  try {
    const parsed = new URL(withoutRef);
    if (parsed.username || parsed.password) throw httpError(400, "package_source_must_not_include_credentials");
    if (["git:", "https:", "ssh:"].includes(parsed.protocol)) {
      return buildGitPackageSource(parsed.hostname, parsed.pathname.replace(/^\/+/, ""), ref || parsed.hash.replace(/^#/, ""));
    }
  } catch (error) {
    if (error && error.status) throw error;
  }
  return null;
}

function buildGitPackageSource(host, gitPath, ref = "") {
  const normalizedHost = String(host || "").trim().toLowerCase();
  const normalizedPath = String(gitPath || "").trim().replace(/\.git$/, "");
  const parts = normalizeStoragePrefix(normalizedPath).split("/").filter(Boolean);
  if (!normalizedHost || !parts.length || parts.some((part) => part === "." || part === "..")) throw httpError(400, "invalid_package_source");
  if (!/^[a-z0-9.-]+$/i.test(normalizedHost)) throw httpError(400, "invalid_package_source");
  return {host: normalizedHost, path: parts.join("/"), ref: String(ref || "").trim()};
}

function piPackageCatalogCollection(uid, dependencies = {}) {
  return dependencies.db.collection("users").doc(uid).collection("piPackageCatalog");
}

function piPackageCatalogDocId(identity) {
  return encodeURIComponent(identity);
}

function piPackageCatalogRecord(source, workspaceId, options = {}, dependencies = {}) {
  const normalized = normalizePiPackageSource(source);
  const now = dependencies.admin.firestore.FieldValue.serverTimestamp();
  return {
    identity: normalized.identity,
    type: normalized.type,
    source: normalized.source,
    updatedAt: now,
    lastWorkspaceId: cleanName(workspaceId || ""),
    installCount: dependencies.admin.firestore.FieldValue.increment(options.incrementInstallCount ? 1 : 0),
    ...(options.includeCreatedAt ? {createdAt: now, favorite: false} : {}),
  };
}

async function requireWorkspaceDependency(dependencies, uid, workspaceId) {
  if (typeof dependencies.requireWorkspace !== "function") throw new Error("Pi packages service requires a requireWorkspace dependency.");
  return dependencies.requireWorkspace(uid, workspaceId);
}

async function requireSessionDependency(dependencies, uid, workspaceId, sessionId) {
  if (typeof dependencies.requireSession !== "function") throw new Error("Pi packages service requires a requireSession dependency.");
  return dependencies.requireSession(uid, workspaceId, sessionId);
}

async function requestRunnerJsonDependency(dependencies, session, routePath, options = {}) {
  if (typeof dependencies.requestRunnerJson !== "function") throw new Error("Pi packages service requires a requestRunnerJson dependency.");
  return dependencies.requestRunnerJson(session, routePath, options);
}

module.exports = {
  buildGitPackageSource,
  createPiPackagesService,
  mergePiPackageCatalogEntry,
  normalizeGitPackageSource,
  normalizePiPackageSource,
  parseGitPackageSource,
  piPackageCatalogDocId,
  piPackageCatalogRecord,
};
