import {createHash} from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const IMPORT_SCHEMA_VERSION = 1;
export const IMPORT_RECEIPT_NAME = ".mapache-hubspot-import.json";

const HISTORY_PREFIX = "sessions/";
const WORKSPACE_PREFIX = "workspace/";
const ATTACHMENT_PREFIX = "attachments/";
const MANIFEST_FILES = new Set(["manifest.json", "manifest.sha256"]);
const CONFIG_PATH_SUFFIXES = [
  ".pi/agent/settings.json",
  ".pi/settings.json",
];
const CONFIG_ARRAY_KEYS = ["packages", "extensions", "launch", "launches"];

export async function verifyHubspotBackup({backupRoot, fsImpl = fs} = {}) {
  if (!backupRoot) throw importError("backup_root_missing", "a Task 23 backup root is required");
  const root = path.resolve(String(backupRoot));
  const manifestPath = path.join(root, "manifest.json");
  const checksumPath = path.join(root, "manifest.sha256");
  let manifest;
  try {
    manifest = JSON.parse(await fsImpl.readFile(manifestPath, "utf8"));
  } catch (error) {
    throw importError("manifest_unreadable", `cannot read the backup manifest: ${manifestPath}`, error);
  }
  if (!manifest || manifest.kind !== "mapache-hubspot-pi-web-export" || manifest.schemaVersion !== 1) {
    throw importError("manifest_unsupported", "backup manifest is not a supported Task 23 export");
  }
  const recordedChecksum = String(manifest.manifestSha256 || "").trim();
  const sidecarChecksum = String(await fsImpl.readFile(checksumPath, "utf8")).trim();
  const unsignedManifest = {...manifest};
  delete unsignedManifest.manifestSha256;
  const calculatedChecksum = sha256(Buffer.from(`${JSON.stringify(unsignedManifest, null, 2)}\n`, "utf8"));
  if (!/^[a-f0-9]{64}$/.test(recordedChecksum) || recordedChecksum !== calculatedChecksum || sidecarChecksum !== calculatedChecksum) {
    throw importError("manifest_checksum_mismatch", "backup manifest checksum verification failed");
  }
  validateManifestIdentity(manifest);
  const files = Array.isArray(manifest.files) ? manifest.files : null;
  if (!files) throw importError("manifest_files_missing", "backup manifest has no file records");

  const backupFiles = await collectBackupFiles(root, fsImpl);
  const expectedFiles = new Set(MANIFEST_FILES);
  const copied = [];
  const skipped = [];
  const history = [];
  const seenBackupPaths = new Set();
  const seenSourcePaths = new Set();
  for (const record of files) {
    validateManifestRecord(record, manifest.source.sessionId);
    const sourcePath = safeRelative(record.sourcePath);
    if (seenSourcePaths.has(sourcePath)) throw importError("manifest_duplicate_path", `source path appears more than once: ${sourcePath}`);
    seenSourcePaths.add(sourcePath);
    if (record.action === "skip") {
      skipped.push(record);
      continue;
    }
    const backupRelativePath = safeRelative(record.backupPath);
    if (seenBackupPaths.has(backupRelativePath)) {
      throw importError("manifest_duplicate_path", `backup path appears more than once: ${backupRelativePath}`);
    }
    seenBackupPaths.add(backupRelativePath);
    expectedFiles.add(backupRelativePath);
    const backupPath = path.join(root, ...backupRelativePath.split("/"));
    const checked = await verifyBackupFile({backupPath, fsImpl, record, root});
    const complete = {
      ...record,
      backupPath: backupRelativePath,
      backupAbsolutePath: backupPath,
    };
    if (record.category === "history") {
      const parsed = parseJsonl(await fsImpl.readFile(backupPath), backupRelativePath);
      if (parsed.trailingIncomplete && manifest.policy?.incompleteTrailingJsonlPreserved !== true) {
        throw importError("history_trailing_record_policy_missing", `incomplete trailing JSONL is not authorized: ${backupRelativePath}`);
      }
      if (Number(record.recordCount) !== parsed.records.length || Boolean(record.trailingIncomplete) !== parsed.trailingIncomplete) {
        throw importError("history_record_count_mismatch", `history record metadata does not match: ${backupRelativePath}`);
      }
      if (parsed.records[0]?.type !== "session" || typeof parsed.records[0]?.id !== "string") {
        throw importError("history_header_invalid", `history has no valid session header: ${backupRelativePath}`);
      }
      complete.records = parsed.records;
      complete.completeRecords = parsed.records.length;
      complete.sourceSessionId = manifest.source.sessionId;
      complete.historySessionId = parsed.records[0].id;
      history.push(complete);
    }
    copied.push({...complete, verified: checked});
  }
  for (const relative of backupFiles) {
    if (!expectedFiles.has(relative)) throw importError("backup_unlisted_file", `backup contains an unlisted file: ${relative}`);
  }
  return {
    backupRoot: root,
    manifest,
    manifestSha256: calculatedChecksum,
    files: copied,
    skipped,
    history: history.sort((a, b) => a.backupPath.localeCompare(b.backupPath)),
    counts: {
      copied: copied.length,
      skipped: skipped.length,
      historyFiles: history.length,
      historyRecords: history.reduce((sum, file) => sum + file.completeRecords, 0),
      trailingIncomplete: history.filter((file) => file.trailingIncomplete).length,
    },
  };
}

export function validateImportPlan({
  backupRoot,
  manifest,
  targetOwnerUid,
  targetPrefix,
  targetSessionId,
  targetSessionRoot,
  targetPiRoot,
  targetUiRoot,
  targetWorkspaceId,
  targetWorkspaceRoot,
} = {}) {
  const required = [
    [backupRoot, "backup root"],
    [targetOwnerUid, "target owner UID"],
    [targetPrefix, "target storage prefix"],
    [targetWorkspaceId, "target workspace ID"],
    [targetSessionId, "target session ID"],
    [targetWorkspaceRoot, "target workspace root"],
    [targetSessionRoot, "target session root"],
    [targetPiRoot, "target Pi config root"],
    [targetUiRoot, "target UI root"],
  ];
  for (const [value, label] of required) {
    if (!String(value || "").trim()) throw importError("argument_missing", `${label} is required`);
  }
  if (!manifest?.source || manifest.kind !== "mapache-hubspot-pi-web-export") {
    throw importError("manifest_missing", "a verified Task 23 manifest is required");
  }
  const normalizedTargetPrefix = normalizePrefix(targetPrefix);
  const sourcePrefix = normalizePrefix(manifest.source.sourcePrefix);
  if (prefixesOverlap(sourcePrefix, normalizedTargetPrefix)) {
    throw importError("source_target_prefix_collision", "source and target storage prefixes overlap");
  }
  const source = manifest.source;
  if (String(targetWorkspaceId).trim() === String(source.workspaceId).trim()) {
    throw importError("source_target_identity_collision", "target workspace ID must differ from the source workspace ID");
  }
  if (String(targetSessionId).trim() === String(source.sessionId).trim()) {
    throw importError("source_target_identity_collision", "target session ID must differ from the source session ID");
  }
  const roots = {
    workspace: path.resolve(String(targetWorkspaceRoot)),
    sessions: path.resolve(String(targetSessionRoot)),
    pi: path.resolve(String(targetPiRoot)),
    ui: path.resolve(String(targetUiRoot)),
  };
  const rootEntries = Object.entries(roots);
  for (let index = 0; index < rootEntries.length; index += 1) {
    for (let other = index + 1; other < rootEntries.length; other += 1) {
      if (pathsOverlap(rootEntries[index][1], rootEntries[other][1])) {
        throw importError("target_root_collision", `target ${rootEntries[index][0]} and ${rootEntries[other][0]} roots overlap`);
      }
    }
  }
  const backupPath = path.resolve(String(backupRoot));
  for (const [name, targetRoot] of rootEntries) {
    if (pathsOverlap(backupPath, targetRoot)) throw importError("backup_target_path_collision", `backup and target ${name} roots overlap`);
  }
  return {
    source: {
      ownerUid: String(source.ownerUid),
      workspaceId: String(source.workspaceId),
      sessionId: String(source.sessionId),
      sourcePrefix,
    },
    target: {
      ownerUid: String(targetOwnerUid).trim(),
      workspaceId: String(targetWorkspaceId).trim(),
      sessionId: String(targetSessionId).trim(),
      targetPrefix: normalizedTargetPrefix,
      ...roots,
    },
    backupRoot: backupPath,
  };
}

export async function importHubspotBackup({
  backupRoot,
  fsImpl = fs,
  historySdk,
  now = () => new Date().toISOString(),
  plan,
  verifyOnly = false,
} = {}) {
  if (!plan) throw importError("plan_missing", "validated import plan is required");
  const verified = await verifyHubspotBackup({backupRoot: backupRoot || plan.backupRoot, fsImpl});
  if (!verified.manifest.policy?.sourceWasQuiesced || !verified.manifest.policy?.sourceWasStopped) {
    throw importError("backup_not_stopped", "the backup does not prove a quiescent, stopped source");
  }
  if (verified.manifest.source.workspaceId !== plan.source.workspaceId ||
      verified.manifest.source.sessionId !== plan.source.sessionId ||
      normalizePrefix(verified.manifest.source.sourcePrefix) !== plan.source.sourcePrefix) {
    throw importError("source_mapping_mismatch", "backup source does not match the validated import plan");
  }
  const desired = await buildDesiredFiles({fsImpl, plan, verified});
  const initialState = await inspectTarget({fsImpl, roots: plan.target, desired});
  if (verifyOnly) {
    if (initialState.status !== "idempotent") {
      throw importError("target_not_imported", "verify-only requires a target containing exactly the validated import");
    }
    const historyCheck = await validateHistory({
      fsImpl,
      historySdk,
      historyFiles: desired.history,
      sessionRoot: plan.target.sessions,
      workspaceRoot: plan.target.workspace,
    });
    return buildReport({historyCheck, initialState, mode: "verify-only", now, plan, verified, desired});
  }
  if (initialState.status === "idempotent") {
    const historyCheck = await validateHistory({
      fsImpl,
      historySdk,
      historyFiles: desired.history,
      sessionRoot: plan.target.sessions,
      workspaceRoot: plan.target.workspace,
    });
    return buildReport({historyCheck, initialState, mode: "import", now, plan, verified, desired});
  }
  if (initialState.status !== "empty") throw importError("target_not_empty", "refusing to overwrite existing target work");

  const stageRoot = await fsImpl.mkdtemp(path.join(os.tmpdir(), "mapache-hubspot-import-"));
  const staged = {
    workspace: path.join(stageRoot, "workspace"),
    sessions: path.join(stageRoot, "sessions"),
    pi: path.join(stageRoot, "pi"),
    ui: path.join(stageRoot, "ui"),
  };
  try {
    for (const root of Object.values(staged)) await fsImpl.mkdir(root, {recursive: true, mode: 0o700});
    await materializeDesired({desired, fsImpl, roots: staged});
    const historyCheck = await validateHistory({
      fsImpl,
      historySdk,
      historyFiles: desired.history,
      sessionRoot: staged.sessions,
      workspaceRoot: staged.workspace,
    });
    const beforeInstall = await inspectTarget({fsImpl, roots: plan.target, desired});
    if (beforeInstall.status !== "empty") throw importError("target_changed_during_import", "target changed while the verified import was staged");
    await materializeDesired({desired, fsImpl, roots: plan.target});
    const installedState = await inspectTarget({fsImpl, roots: plan.target, desired});
    if (installedState.status !== "idempotent") throw importError("target_install_verification_failed", "installed target did not match the staged import");
    return buildReport({historyCheck, initialState, mode: "import", now, plan, verified, desired});
  } catch (error) {
    await removeCreatedTargetRoots({fsImpl, roots: plan.target, desired}).catch(() => {});
    throw error;
  } finally {
    await fsImpl.rm(stageRoot, {recursive: true, force: true}).catch(() => {});
  }
}

export async function verifyHubspotImport(options = {}) {
  return importHubspotBackup({...options, verifyOnly: true});
}

export function createPiSdkHistoryValidator({sdkModule, sessionRoot, workspaceRoot} = {}) {
  const SessionManager = sdkModule?.SessionManager;
  if (!SessionManager || typeof SessionManager.open !== "function" ||
      (typeof SessionManager.listAll !== "function" && typeof SessionManager.list !== "function")) {
    throw importError("pi_sdk_history_api_missing", "the pinned Pi SDK must provide SessionManager.listAll/list and SessionManager.open");
  }
  return {
    async listSessions({sessionRoot: requestedSessionRoot = sessionRoot, workspaceRoot: requestedWorkspaceRoot = workspaceRoot} = {}) {
      if (typeof SessionManager.listAll === "function") return SessionManager.listAll(requestedSessionRoot);
      return SessionManager.list(requestedWorkspaceRoot, requestedSessionRoot);
    },
    async openSession({sessionPath, sessionRoot: requestedSessionRoot = sessionRoot, workspaceRoot: requestedWorkspaceRoot = workspaceRoot}) {
      const manager = SessionManager.open(sessionPath, requestedSessionRoot, requestedWorkspaceRoot);
      return {
        sessionPath: manager.getSessionFile(),
        sessionId: manager.getSessionId(),
        entries: manager.getEntries(),
        modelCalls: 0,
      };
    },
  };
}

async function buildDesiredFiles({fsImpl, plan, verified}) {
  const entries = [];
  const history = [];
  const configDiffs = [];
  const targetKeys = new Set();
  for (const record of verified.files) {
    const mapped = mapRecord(record);
    if (mapped.rootName === "pi" && isCredentialPath(mapped.relativePath)) {
      throw importError("pi_credentials_not_migrated", `credentials are regenerated, not imported: ${record.sourcePath}`);
    }
    let content;
    let symlinkTarget;
    if (record.kind === "symlink") {
      symlinkTarget = record.target;
    } else {
      content = await fsImpl.readFile(record.backupAbsolutePath);
    }
    if (mapped.rootName === "pi" && record.kind !== "symlink" && (mapped.managedConfig || isManagedSettingsPath(mapped.relativePath))) {
      const transformed = transformManagedSettings(content, mapped.relativePath);
      if (transformed.changed) {
        configDiffs.push(transformed.diff);
        content = transformed.content;
      }
    }
    const entry = {
      ...mapped,
      kind: record.kind || "file",
      mode: Number(record.mode) & 0o777,
      sourcePath: record.sourcePath,
      sourceSha256: record.sha256,
      sourceByteLength: record.byteLength,
      backupPath: record.backupPath,
      content,
      symlinkTarget,
    };
    const targetKey = `${entry.rootName}/${entry.relativePath}`;
    if (targetKeys.has(targetKey)) throw importError("target_path_collision", `multiple backup files map to the same target path: ${targetKey}`);
    targetKeys.add(targetKey);
    entry.sha256 = entry.kind === "symlink" ? sha256(Buffer.from(symlinkTarget)) : sha256(content);
    entry.byteLength = entry.kind === "symlink" ? Buffer.byteLength(symlinkTarget) : content.length;
    entries.push(entry);
    if (record.category === "history") history.push({...entry, historyRecord: record});
  }
  if (targetKeys.has(`pi/${IMPORT_RECEIPT_NAME}`)) throw importError("target_path_collision", `backup content conflicts with the importer receipt: ${IMPORT_RECEIPT_NAME}`);
  const receipt = buildReceipt({configDiffs, entries, plan, verified});
  entries.push({
    rootName: "pi",
    relativePath: IMPORT_RECEIPT_NAME,
    kind: "file",
    mode: 0o600,
    sourcePath: null,
    sourceSha256: null,
    sourceByteLength: receipt.length,
    backupPath: null,
    content: receipt,
    sha256: sha256(receipt),
    byteLength: receipt.length,
    receipt: true,
  });
  return {entries, history, configDiffs, receipt};
}

function mapRecord(record) {
  const sourcePath = safeRelative(record.sourcePath);
    if (record.category === "workspace") {
    const relativePath = sourcePath.slice(WORKSPACE_PREFIX.length);
    if (relativePath.startsWith(".pi/agent/")) {
      return {rootName: "pi", relativePath: relativePath.slice(".pi/agent/".length), managedConfig: relativePath.endsWith("/settings.json")};
    }
    if (relativePath === ".pi/agent/settings.json") return {rootName: "pi", relativePath: "settings.json", managedConfig: true};
    return {rootName: "workspace", relativePath};
  }
  if (record.category === "pi") return {rootName: "pi", relativePath: sourcePath.slice("pi/".length)};
  if (record.category === "ui") return {rootName: "ui", relativePath: sourcePath.slice("ui/".length)};
  if (record.category === "attachment") return {rootName: "ui", relativePath: sourcePath.slice(ATTACHMENT_PREFIX.length)};
  if (record.category === "history") {
    const sourcePrefix = `${HISTORY_PREFIX}${record.sourceSessionId || ""}/`;
    if (!sourcePath.startsWith(sourcePrefix)) throw importError("history_path_invalid", `history path is not under its source session: ${sourcePath}`);
    return {rootName: "sessions", relativePath: path.posix.basename(sourcePath.slice(sourcePrefix.length))};
  }
  throw importError("record_category_unsupported", `unsupported backup record category: ${record.category}`);
}

async function validateHistory({fsImpl, historySdk, historyFiles, sessionRoot, workspaceRoot}) {
  if (!historySdk || typeof historySdk.listSessions !== "function" || typeof historySdk.openSession !== "function") {
    throw importError("pi_sdk_history_validator_required", "history validation requires the pinned Pi SDK list/open adapter");
  }
  const listed = await historySdk.listSessions({sessionRoot, workspaceRoot});
  if (!Array.isArray(listed)) throw importError("pi_sdk_list_invalid", "Pi SDK history listing did not return an array");
  const expected = new Map(historyFiles.map((file) => [path.resolve(sessionRoot, file.relativePath), file]));
  const listedByPath = new Map();
  for (const item of listed) {
    const itemPath = path.resolve(String(item?.path || item?.sessionPath || ""));
    if (!isPathInsideOrEqual(sessionRoot, itemPath) || listedByPath.has(itemPath)) {
      throw importError("pi_sdk_list_invalid", "Pi SDK listed a foreign or duplicate history path");
    }
    listedByPath.set(itemPath, item);
  }
  if (listedByPath.size !== expected.size) throw importError("history_discovery_mismatch", "Pi SDK history discovery did not return every imported JSONL file");
  const opened = [];
  for (const [sessionPath, expectedFile] of expected) {
    const listedItem = listedByPath.get(sessionPath);
    if (!listedItem) throw importError("history_discovery_mismatch", `Pi SDK did not discover ${expectedFile.relativePath}`);
    const openedSession = await historySdk.openSession({sessionPath, listed: listedItem, sessionRoot, workspaceRoot});
    if (!openedSession || path.resolve(String(openedSession.sessionPath || sessionPath)) !== sessionPath) {
      throw importError("history_open_mismatch", `Pi SDK opened the wrong history path: ${expectedFile.relativePath}`);
    }
    if (Number(openedSession.modelCalls || 0) !== 0) throw importError("history_open_started_model", "history validation invoked a model call");
    const parsed = expectedFile.historyRecord.records;
    const entries = Array.isArray(openedSession.entries) ? openedSession.entries : null;
    if (!entries || entries.length !== parsed.filter((entry) => entry.type !== "session").length) {
      throw importError("history_entry_count_mismatch", `Pi SDK opened an incomplete history: ${expectedFile.relativePath}`);
    }
    if (JSON.stringify(entries) !== JSON.stringify(parsed.filter((entry) => entry.type !== "session"))) {
      throw importError("history_content_mismatch", `Pi SDK changed history entries while opening: ${expectedFile.relativePath}`);
    }
    opened.push({
      relativePath: expectedFile.relativePath,
      sessionId: expectedFile.historyRecord.sessionId,
      recordCount: expectedFile.historyRecord.completeRecords,
      branchCount: parsed.filter((entry) => entry.type === "branch").length,
      trailingIncomplete: expectedFile.historyRecord.trailingIncomplete === true,
    });
  }
  return {
    discoveredFiles: listedByPath.size,
    openedFiles: opened.length,
    records: opened.reduce((sum, item) => sum + item.recordCount, 0),
    branches: opened.reduce((sum, item) => sum + item.branchCount, 0),
    trailingIncomplete: opened.filter((item) => item.trailingIncomplete).length,
    sessions: opened.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
  };
}

async function materializeDesired({desired, fsImpl, roots}) {
  for (const rootName of ["workspace", "sessions", "pi", "ui"]) {
    await fsImpl.mkdir(roots[rootName], {recursive: true, mode: 0o700});
  }
  const targetPaths = new Set();
  for (const entry of desired.entries) {
    const relative = safeRelative(entry.relativePath);
    const destination = path.resolve(roots[entry.rootName], ...relative.split("/"));
    if (!isPathInsideOrEqual(roots[entry.rootName], destination) || targetPaths.has(destination)) {
      throw importError("target_path_invalid", `import destination is unsafe or duplicated: ${entry.rootName}/${relative}`);
    }
    targetPaths.add(destination);
    await fsImpl.mkdir(path.dirname(destination), {recursive: true, mode: 0o700});
    if (entry.kind === "symlink") {
      const resolvedTarget = path.resolve(path.dirname(destination), entry.symlinkTarget);
      if (path.isAbsolute(entry.symlinkTarget) || !isPathInsideOrEqual(roots[entry.rootName], resolvedTarget)) {
        throw importError("unsafe_symlink", `import symlink escapes its target root: ${entry.sourcePath || relative}`);
      }
      await fsImpl.symlink(entry.symlinkTarget, destination);
    } else {
      await fsImpl.writeFile(destination, entry.content, {mode: entry.mode, flag: "wx"});
      await fsImpl.chmod(destination, entry.mode);
    }
  }
}

async function inspectTarget({fsImpl, roots, desired}) {
  const expected = new Map();
  for (const entry of desired.entries) {
    const destination = path.resolve(roots[entry.rootName], ...safeRelative(entry.relativePath).split("/"));
    expected.set(destination, entry);
  }
  const actual = [];
  for (const rootName of ["workspace", "sessions", "pi", "ui"]) {
    actual.push(...(await collectTreeFiles(roots[rootName], fsImpl)));
  }
  if (actual.length === 0) return {status: "empty", files: []};
  if (actual.length !== expected.size) return {status: "changed", files: actual};
  for (const actualPath of actual) {
    const entry = expected.get(actualPath);
    if (!entry || !(await targetMatches({actualPath, entry, fsImpl}))) return {status: "changed", files: actual};
  }
  return {status: "idempotent", files: actual};
}

async function targetMatches({actualPath, entry, fsImpl}) {
  const stat = await fsImpl.lstat(actualPath);
  if (entry.kind === "symlink") return stat.isSymbolicLink() && await fsImpl.readlink(actualPath) === entry.symlinkTarget;
  if (!stat.isFile()) return false;
  if ((stat.mode & 0o777) !== entry.mode) return false;
  const content = await fsImpl.readFile(actualPath);
  return content.length === entry.byteLength && sha256(content) === entry.sha256;
}

async function removeCreatedTargetRoots({fsImpl, roots, desired}) {
  for (const rootName of ["workspace", "sessions", "pi", "ui"]) {
    const root = roots[rootName];
    const files = await collectTreeFiles(root, fsImpl);
    if (!files.length) continue;
    const allowed = files.every((file) => desired.entries.some((entry) => path.resolve(root, ...safeRelative(entry.relativePath).split("/")) === file));
    if (allowed) await fsImpl.rm(root, {recursive: true, force: true});
  }
}

function buildReceipt({configDiffs, entries, plan, verified}) {
  const files = entries.map((entry) => ({
    root: entry.rootName,
    path: entry.relativePath,
    kind: entry.kind,
    mode: entry.mode,
    byteLength: entry.byteLength,
    sha256: entry.sha256,
  })).sort((a, b) => `${a.root}/${a.path}`.localeCompare(`${b.root}/${b.path}`));
  return Buffer.from(`${JSON.stringify({
    schemaVersion: IMPORT_SCHEMA_VERSION,
    kind: "mapache-hubspot-pi-web-import",
    sourceManifestSha256: verified.manifestSha256,
    source: verified.manifest.source,
    target: plan.target,
    files,
    intentionalConfigChanges: configDiffs,
  }, null, 2)}\n`, "utf8");
}

function buildReport({historyCheck, initialState, mode, now, plan, verified, desired}) {
  return {
    schemaVersion: IMPORT_SCHEMA_VERSION,
    kind: "mapache-hubspot-pi-web-import-report",
    mode,
    status: initialState.status === "idempotent" ? "idempotent" : "imported",
    generatedAt: now(),
    backup: {
      root: verified.backupRoot,
      manifestSha256: verified.manifestSha256,
      copiedFiles: verified.counts.copied,
      skippedFiles: verified.counts.skipped,
      trailingIncompleteJsonl: verified.counts.trailingIncomplete,
    },
    source: plan.source,
    target: plan.target,
    files: {
      imported: desired.entries.length,
      byRoot: Object.fromEntries(Object.keys(plan.target).filter((key) => ["workspace", "sessions", "pi", "ui"].includes(key)).map((key) => [
        key,
        desired.entries.filter((entry) => entry.rootName === key).length,
      ])),
      checksums: desired.entries.map((entry) => ({
        root: entry.rootName,
        path: entry.relativePath,
        kind: entry.kind,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
      })).sort((a, b) => `${a.root}/${a.path}`.localeCompare(`${b.root}/${b.path}`)),
    },
    history: historyCheck,
    intentionalConfigChanges: desired.configDiffs,
    errors: [],
  };
}

function transformManagedSettings(content, relativePath) {
  let parsed;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw importError("managed_config_invalid_json", `managed Pi settings are not valid JSON: ${relativePath}`, error);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw importError("managed_config_invalid_shape", `managed Pi settings must be a JSON object: ${relativePath}`);
  }
  const changes = [];
  const transformed = structuredClone(parsed);
  for (const key of CONFIG_ARRAY_KEYS) {
    if (!Array.isArray(transformed[key])) continue;
    const retained = [];
    transformed[key].forEach((entry, index) => {
      if (containsPiGoalX(entry)) changes.push({path: `settings.${key}[${index}]`, action: "removed", reason: "conflicting-pi-goal-x-launch-declaration"});
      else retained.push(entry);
    });
    transformed[key] = retained;
  }
  if (!changes.length) return {changed: false, content, diff: null};
  const nextContent = Buffer.from(`${JSON.stringify(transformed, null, 2)}\n`, "utf8");
  return {
    changed: true,
    content: nextContent,
    diff: {
      path: relativePath,
      beforeSha256: sha256(content),
      afterSha256: sha256(nextContent),
      changes,
    },
  };
}

function containsPiGoalX(value) {
  if (typeof value === "string") return value.toLowerCase().includes("pi-goal-x");
  if (!value || typeof value !== "object") return false;
  return [value.source, value.package, value.name, value.command, value.id]
      .some((candidate) => typeof candidate === "string" && candidate.toLowerCase().includes("pi-goal-x"));
}

async function verifyBackupFile({backupPath, fsImpl, record, root}) {
  if (!isPathInsideOrEqual(root, backupPath)) throw importError("backup_path_invalid", `backup path escapes the backup root: ${record.backupPath}`);
  let stat;
  try {
    stat = await fsImpl.lstat(backupPath);
  } catch (error) {
    throw importError("backup_file_missing", `backup file is missing: ${record.backupPath}`, error);
  }
  if (record.kind === "symlink") {
    if (!stat.isSymbolicLink()) throw importError("backup_kind_mismatch", `backup symlink is not a symlink: ${record.backupPath}`);
    const target = await fsImpl.readlink(backupPath);
    const resolvedTarget = path.resolve(path.dirname(backupPath), target);
    if (path.isAbsolute(target) || !isPathInsideOrEqual(root, resolvedTarget)) throw importError("unsafe_symlink", `backup symlink escapes the backup root: ${record.backupPath}`);
    if (target !== record.target || Buffer.byteLength(target) !== record.byteLength || sha256(Buffer.from(target)) !== record.sha256) {
      throw importError("backup_checksum_mismatch", `backup symlink metadata does not match: ${record.backupPath}`);
    }
    return true;
  }
  if (!stat.isFile()) throw importError("backup_kind_mismatch", `backup record is not a regular file: ${record.backupPath}`);
  const content = await fsImpl.readFile(backupPath);
  if (content.length !== record.byteLength || (stat.mode & 0o777) !== (Number(record.mode) & 0o777) || sha256(content) !== record.sha256) {
    throw importError("backup_checksum_mismatch", `backup checksum or metadata does not match: ${record.backupPath}`);
  }
  return true;
}

function validateManifestIdentity(manifest) {
  const source = manifest.source;
  for (const key of ["ownerUid", "workspaceId", "sessionId", "sourcePrefix"]) {
    if (!String(source?.[key] || "").trim()) throw importError("manifest_source_incomplete", `manifest source is missing ${key}`);
  }
  if (manifest.policy?.sourceWasQuiesced !== true || manifest.policy?.sourceWasStopped !== true) {
    throw importError("backup_not_stopped", "manifest does not prove quiescent and stopped capture");
  }
}

function validateManifestRecord(record, sourceSessionId) {
  if (!record || (record.action !== "copy" && record.action !== "skip")) throw importError("manifest_record_invalid", "manifest contains an invalid file action");
  safeRelative(record.sourcePath);
  if (record.action === "skip") {
    if (!String(record.reason || "").trim()) throw importError("manifest_record_invalid", `skipped record has no reason: ${record.sourcePath}`);
    return;
  }
  if (!String(record.backupPath || "").trim() || !String(record.category || "").trim() || !/^[a-f0-9]{64}$/.test(String(record.sha256 || ""))) {
    throw importError("manifest_record_invalid", `copied record is missing checksummed metadata: ${record.sourcePath}`);
  }
  if (!Number.isInteger(record.byteLength) || record.byteLength < 0 || !Number.isInteger(record.mode)) {
    throw importError("manifest_record_invalid", `copied record has invalid size or permission metadata: ${record.sourcePath}`);
  }
  const sourcePath = safeRelative(record.sourcePath);
  const backupPath = safeRelative(record.backupPath);
  if (record.category === "workspace") {
    if (!sourcePath.startsWith(WORKSPACE_PREFIX) || isChromePath(sourcePath)) throw importError("chrome_or_workspace_path_invalid", `Chrome or invalid workspace state was copied: ${sourcePath}`);
    if (backupPath !== sourcePath) throw importError("manifest_path_mismatch", `workspace backup path does not match source path: ${sourcePath}`);
  } else if (record.category === "history") {
    if (!sourcePath.startsWith(`${HISTORY_PREFIX}${sourceSessionId}/`) || backupPath !== sourcePath || !sourcePath.endsWith(".jsonl")) {
      throw importError("history_path_invalid", `history record is outside the selected session: ${sourcePath}`);
    }
  } else if (record.category === "attachment") {
    if (!sourcePath.startsWith(ATTACHMENT_PREFIX) || backupPath !== sourcePath) throw importError("attachment_path_invalid", `attachment record is invalid: ${sourcePath}`);
  } else if (record.category === "pi" || record.category === "ui") {
    if (!backupPath.startsWith(`${record.category}/`)) throw importError("manifest_path_mismatch", `managed-state backup path does not match source path: ${sourcePath}`);
  } else {
    throw importError("record_category_unsupported", `unsupported backup record category: ${record.category}`);
  }
}

async function collectBackupFiles(root, fsImpl) {
  const files = await collectTreeFiles(root, fsImpl);
  return files.map((file) => path.relative(root, file).split(path.sep).join("/"));
}

async function collectTreeFiles(root, fsImpl) {
  const output = [];
  let stat;
  try {
    stat = await fsImpl.lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return output;
    throw error;
  }
  if (stat.isFile() || stat.isSymbolicLink()) return [root];
  if (!stat.isDirectory()) return output;
  for (const entry of (await fsImpl.readdir(root, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await collectTreeFiles(child, fsImpl));
    else output.push(child);
  }
  return output;
}

function parseJsonl(content, sourcePath) {
  const text = content.toString("utf8");
  const lines = text.split("\n");
  const trailingNewline = text.endsWith("\n");
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, "");
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      if (!trailingNewline && index === lines.length - 1) return {records, trailingIncomplete: true};
      throw importError("history_malformed_jsonl", `malformed non-trailing JSONL record: ${sourcePath}`, error);
    }
  }
  return {records, trailingIncomplete: false};
}

function isManagedSettingsPath(relativePath) {
  return CONFIG_PATH_SUFFIXES.some((suffix) => relativePath === suffix || relativePath.endsWith(`/${suffix}`));
}

function isCredentialPath(relativePath) {
  return /(?:^|\/)(?:auth\.json|provider-keys\.json|credentials?\.json|oauth(?:-tokens?)?\.json)$/i.test(relativePath);
}

function isChromePath(relativePath) {
  return /^workspace\/\.mapache-internal\/chrome(?:\/|$)/.test(relativePath) ||
    /^workspace\/.config\/(?:google-chrome|chromium)(?:\/|$)/.test(relativePath) ||
    /(?:^|\/)chrome-profile\.tar\.gz$/.test(relativePath);
}

function normalizePrefix(value) {
  const raw = String(value || "").trim();
  const clean = raw.startsWith("gs://") ? raw.slice(5).split("/").slice(1).join("/") : raw;
  if (!clean || clean.split("/").some((part) => part === "..")) throw importError("prefix_invalid", "storage prefix must be non-empty and must not contain traversal");
  return clean.replace(/^\/+|\/+$/g, "");
}

function prefixesOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function pathsOverlap(left, right) {
  return path.resolve(left) === path.resolve(right) || isPathInsideOrEqual(left, right) || isPathInsideOrEqual(right, left);
}

function isPathInsideOrEqual(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeRelative(value) {
  const relative = String(value || "").trim().replaceAll("\\", "/");
  if (!relative || relative.startsWith("/") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw importError("path_traversal", `unsafe relative path: ${value}`);
  }
  return relative;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function importError(code, message, cause) {
  const error = new Error(message, cause ? {cause} : undefined);
  error.code = code;
  return error;
}
