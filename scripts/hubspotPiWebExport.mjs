import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

export const EXPORT_SCHEMA_VERSION = 1;
export const DEFAULT_INVENTORY_PATH = "artifacts/migrations/pi-web-ui/hubspot/2026-09-11-inventory.md";

const CHROME_PATH_PATTERNS = [
  /^\.mapache-internal\/chrome(?:\/|$)/,
  /^\.config\/(?:google-chrome|chromium)(?:\/|$)/,
  /(?:^|\/)chrome-profile\.tar\.gz$/,
];

export function parseInventory(markdown) {
  const text = String(markdown || "");
  const workspaceId = inventoryField(text, "Workspace ID");
  const ownerUid = inventoryField(text, "Owner UID");
  const workspaceStoragePrefix = inventoryField(text, "Workspace storage prefix");
  const sessionId = inventoryField(text, "Session ID");
  const sessionArchivePrefix = inventoryField(text, "Session archive prefix");
  if (!workspaceId || !ownerUid || !workspaceStoragePrefix || !sessionId || !sessionArchivePrefix) {
    throw exportError("inventory_incomplete", "Task 1 inventory is missing a required source mapping");
  }
  return {
    workspaceId,
    ownerUid,
    workspaceStoragePrefix,
    sessionId,
    sessionArchivePrefix,
  };
}

export function validateExportPlan({
  inventory,
  ownerUid,
  outputPrefix,
  sessionId,
  sourcePrefix,
  sourceRoot,
  workspaceId,
} = {}) {
  const required = [
    [ownerUid, "owner UID"],
    [workspaceId, "workspace ID"],
    [sessionId, "session ID"],
    [sourcePrefix, "source prefix"],
    [outputPrefix, "output prefix"],
  ];
  for (const [value, label] of required) {
    if (!String(value || "").trim()) throw exportError("argument_missing", `${label} is required`);
  }
  if (!inventory || typeof inventory !== "object") throw exportError("inventory_missing", "Task 1 inventory is required");
  for (const [actual, expected, label] of [
    [String(ownerUid).trim(), inventory.ownerUid, "owner UID"],
    [String(workspaceId).trim(), inventory.workspaceId, "workspace ID"],
    [String(sessionId).trim(), inventory.sessionId, "session ID"],
    [normalizeRemotePrefix(sourcePrefix), normalizeRemotePrefix(inventory.workspaceStoragePrefix), "source prefix"],
  ]) {
    if (actual !== expected) throw exportError("source_mapping_mismatch", `${label} does not match the restricted Task 1 inventory`);
  }

  const normalizedOutputPrefix = normalizeRemotePrefix(outputPrefix);
  if (prefixesOverlap(normalizeRemotePrefix(sourcePrefix), normalizedOutputPrefix)) {
    throw exportError("source_output_prefix_collision", "source and output prefixes overlap");
  }
  const plan = {
    ownerUid: String(ownerUid).trim(),
    workspaceId: String(workspaceId).trim(),
    sessionId: String(sessionId).trim(),
    sourcePrefix: normalizeRemotePrefix(sourcePrefix),
    outputPrefix: normalizedOutputPrefix,
  };
  if (sourceRoot) {
    const sourcePath = path.resolve(String(sourceRoot));
    const outputPath = path.resolve(String(outputPrefix));
    if (samePath(sourcePath, outputPath) || isPathInside(sourcePath, outputPath) || isPathInside(outputPath, sourcePath)) {
      throw exportError("source_output_path_collision", "source and output directories overlap");
    }
    plan.sourceRoot = sourcePath;
  }
  return plan;
}

export function buildDryRunPlan(plan) {
  return {
    mode: "dry-run",
    source: {
      ownerUid: plan.ownerUid,
      workspaceId: plan.workspaceId,
      sessionId: plan.sessionId,
      sourcePrefix: plan.sourcePrefix,
    },
    outputPrefix: plan.outputPrefix,
    controller: "not invoked",
    capture: {
      workspaceFiles: "all readable files under the supplied workspace root, including hidden files and .git",
      piHistory: `only JSONL files under the selected session ${plan.sessionId}`,
      attachments: "readable files referenced by selected history",
      excluded: "Chrome profile state and other sessions",
    },
    writes: "none",
  };
}

export async function exportHubspotBackup({
  attachmentsRoot,
  controller,
  fsImpl = fs,
  now = () => new Date().toISOString(),
  outputRoot,
  plan,
  sessionRoot,
  workspaceRoot,
} = {}) {
  if (!plan) throw exportError("plan_missing", "validated export plan is required");
  if (!workspaceRoot || !sessionRoot || !outputRoot) {
    throw exportError("capture_root_missing", "workspace, selected session, and output roots are required for execution");
  }
  const workspacePath = path.resolve(String(workspaceRoot));
  const selectedSessionPath = path.resolve(String(sessionRoot));
  const outputPath = path.resolve(String(outputRoot));
  if (path.basename(selectedSessionPath) !== plan.sessionId) {
    throw exportError("selected_session_mismatch", "selected session root must end with the explicit source session ID");
  }
  if (samePath(workspacePath, outputPath) || samePath(selectedSessionPath, outputPath) ||
      isPathInside(workspacePath, outputPath) || isPathInside(outputPath, workspacePath) ||
      isPathInside(selectedSessionPath, outputPath) || isPathInside(outputPath, selectedSessionPath)) {
    throw exportError("source_output_path_collision", "source and output directories overlap");
  }
  await assertFinalCaptureController(controller, plan);
  await fsImpl.mkdir(outputPath, {recursive: false, mode: 0o700}).catch((error) => {
    if (error?.code === "EEXIST") throw exportError("output_exists", "refusing to overwrite an existing export prefix");
    throw error;
  });

  const records = [];
  const referencedWorkspaceFiles = new Set();
  const historyRecords = [];
  try {
    await walkWorkspace({fsImpl, records, root: workspacePath, destinationRoot: outputPath});
    await walkHistory({
      fsImpl,
      historyRecords,
      records,
      root: selectedSessionPath,
      destinationRoot: outputPath,
      sessionId: plan.sessionId,
    });
    await copyReferencedAttachments({
      attachmentsRoot,
      destinationRoot: outputPath,
      fsImpl,
      historyRecords,
      records,
      referencedWorkspaceFiles,
      workspaceRoot: workspacePath,
    });
    for (const record of records) {
      if (record.action === "copy" && referencedWorkspaceFiles.has(record.sourcePath)) {
        record.referencedByHistory = true;
      }
    }
    const payload = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      kind: "mapache-hubspot-pi-web-export",
      capturedAt: now(),
      source: {
        ownerUid: plan.ownerUid,
        workspaceId: plan.workspaceId,
        sessionId: plan.sessionId,
        sourcePrefix: plan.sourcePrefix,
      },
      outputPrefix: plan.outputPrefix,
      policy: {
        sourceWasQuiesced: true,
        sourceWasStopped: true,
        chromeProfileExcluded: true,
        otherSessionsExcluded: true,
        incompleteTrailingJsonlPreserved: true,
      },
      files: records.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
    };
    const unsigned = `${JSON.stringify(payload, null, 2)}\n`;
    const manifestSha256 = sha256(Buffer.from(unsigned, "utf8"));
    const manifest = {...payload, manifestSha256};
    await fsImpl.writeFile(path.join(outputPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {mode: 0o600});
    await fsImpl.writeFile(path.join(outputPath, "manifest.sha256"), `${manifestSha256}\n`, {mode: 0o600});
    return {
      ok: true,
      outputRoot: outputPath,
      manifestPath: path.join(outputPath, "manifest.json"),
      manifestSha256,
      copied: records.filter((entry) => entry.action === "copy").length,
      skipped: records.filter((entry) => entry.action === "skip").length,
      trailingIncompleteJsonl: records.filter((entry) => entry.trailingIncomplete === true).length,
    };
  } catch (error) {
    await fsImpl.rm(outputPath, {recursive: true, force: true}).catch(() => {});
    throw error;
  }
}

async function assertFinalCaptureController(controller, plan) {
  if (!controller || typeof controller.quiesce !== "function" || typeof controller.stop !== "function") {
    throw exportError("source_controller_required", "execution requires the actual source quiesce and stop controller");
  }
  const quiesced = await controller.quiesce({source: plan});
  if (!isQuiescentProof(quiesced)) {
    throw exportError("source_not_quiescent", "source controller did not prove that writers drained");
  }
  const stopped = await controller.stop({source: plan, quiesced});
  if (!(stopped === true || stopped?.stopped === true || stopped?.state === "stopped")) {
    throw exportError("source_stop_failed", "source controller did not confirm a stopped source");
  }
}

function isQuiescentProof(value) {
  if (!value || value.quiesced !== true) return false;
  const counters = ["activeWriters", "activeConversations", "activeTools", "pendingMessages"]
      .filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  return counters.length > 0 && counters.every((key) => Number(value[key]) === 0);
}

async function walkWorkspace({destinationRoot, fsImpl, records, root, relative = ""}) {
  const names = await fsImpl.readdir(path.join(root, relative));
  for (const name of names.sort()) {
    const childRelative = relative ? `${relative}/${name}` : name;
    if (isChromePath(childRelative)) {
      records.push({action: "skip", category: "workspace", sourcePath: `workspace/${childRelative}`, reason: "chrome-profile-state"});
      continue;
    }
    const sourcePath = path.join(root, childRelative);
    const stat = await fsImpl.lstat(sourcePath);
    if (stat.isDirectory()) {
      await walkWorkspace({destinationRoot, fsImpl, records, root, relative: childRelative});
    } else if (stat.isFile()) {
      records.push(await copyFileRecord({
        category: "workspace",
        destinationPath: path.join(destinationRoot, "workspace", childRelative),
        fsImpl,
        sourcePath,
        sourceRelativePath: `workspace/${childRelative}`,
        backupRelativePath: `workspace/${childRelative}`,
      }));
    } else if (stat.isSymbolicLink()) {
      records.push(await copySafeSymlink({
        category: "workspace",
        destinationPath: path.join(destinationRoot, "workspace", childRelative),
        fsImpl,
        root,
        sourcePath,
        sourceRelativePath: `workspace/${childRelative}`,
        backupRelativePath: `workspace/${childRelative}`,
      }));
    } else {
      records.push({action: "skip", category: "workspace", sourcePath: `workspace/${childRelative}`, reason: "unsupported-file-type"});
    }
  }
}

async function walkHistory({destinationRoot, fsImpl, historyRecords, records, root, sessionId, relative = ""}) {
  const names = await fsImpl.readdir(path.join(root, relative));
  for (const name of names.sort()) {
    const childRelative = relative ? `${relative}/${name}` : name;
    const sourcePath = path.join(root, childRelative);
    const stat = await fsImpl.lstat(sourcePath);
    if (stat.isDirectory()) {
      await walkHistory({destinationRoot, fsImpl, historyRecords, records, root, sessionId, relative: childRelative});
      continue;
    }
    if (!stat.isFile()) {
      records.push({action: "skip", category: "history", sourcePath: `sessions/${sessionId}/${childRelative}`, reason: "unsupported-file-type"});
      continue;
    }
    if (!childRelative.endsWith(".jsonl")) {
      records.push({action: "skip", category: "history", sourcePath: `sessions/${sessionId}/${childRelative}`, reason: "not-jsonl-history"});
      continue;
    }
    const content = await fsImpl.readFile(sourcePath);
    const parsed = parseJsonl(content, sourcePath);
    for (const record of parsed.records) historyRecords.push(record);
    const copied = await copyFileRecord({
      category: "history",
      destinationPath: path.join(destinationRoot, "sessions", sessionId, childRelative),
      fsImpl,
      sourcePath,
      sourceRelativePath: `sessions/${sessionId}/${childRelative}`,
      backupRelativePath: `sessions/${sessionId}/${childRelative}`,
    });
    copied.completeRecords = parsed.completeRecords;
    copied.recordCount = parsed.records.length;
    copied.trailingIncomplete = parsed.trailingIncomplete;
    records.push(copied);
  }
}

async function copyReferencedAttachments({attachmentsRoot, destinationRoot, fsImpl, historyRecords, records, referencedWorkspaceFiles, workspaceRoot}) {
  const references = new Set();
  for (const record of historyRecords) collectFileReferences(record, references);
  const copiedAttachments = new Set();
  for (const reference of references) {
    const workspaceCandidate = resolveInside(workspaceRoot, reference);
    if (workspaceCandidate) {
      try {
        const workspaceStat = await fsImpl.lstat(workspaceCandidate);
        if (workspaceStat.isFile()) {
          referencedWorkspaceFiles.add(`workspace/${path.relative(workspaceRoot, workspaceCandidate).split(path.sep).join("/")}`);
          continue;
        }
      } catch (error) {
        // The reference may point at the separate attachment materialization.
      }
    }
    if (!attachmentsRoot) {
      records.push({action: "skip", category: "attachment", sourcePath: `attachments/${reference}`, reason: "attachment_root_not_supplied"});
      continue;
    }
    const attachmentCandidate = resolveInside(path.resolve(attachmentsRoot), reference);
    if (!attachmentCandidate) {
      records.push({action: "skip", category: "attachment", sourcePath: `attachments/${reference}`, reason: "attachment_path_outside_root"});
      continue;
    }
    const relative = path.relative(path.resolve(attachmentsRoot), attachmentCandidate).split(path.sep).join("/");
    if (copiedAttachments.has(relative)) continue;
    copiedAttachments.add(relative);
    try {
      const stat = await fsImpl.lstat(attachmentCandidate);
      if (!stat.isFile()) throw new Error("not a regular file");
      records.push(await copyFileRecord({
        category: "attachment",
        destinationPath: path.join(destinationRoot, "attachments", relative),
        fsImpl,
        sourcePath: attachmentCandidate,
        sourceRelativePath: `attachments/${relative}`,
        backupRelativePath: `attachments/${relative}`,
      }));
    } catch (error) {
      records.push({action: "skip", category: "attachment", sourcePath: `attachments/${relative}`, reason: "attachment_unreadable"});
    }
  }
}

function collectFileReferences(value, output) {
  if (typeof value === "string") {
    const pattern = /<file\b[^>]*\bpath=(?:"([^"]+)"|'([^']+)')/g;
    for (const match of value.matchAll(pattern)) output.add(match[1] || match[2]);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFileReferences(item, output);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectFileReferences(item, output);
  }
}

function parseJsonl(content, sourcePath) {
  const text = content.toString("utf8");
  const lines = text.split("\n");
  const hasTrailingNewline = text.endsWith("\n");
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, "");
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      const isTrailing = !hasTrailingNewline && index === lines.length - 1;
      if (isTrailing) return {completeRecords: false, records, trailingIncomplete: true};
      throw exportError("history_malformed_jsonl", `Malformed non-trailing JSONL record: ${sourcePath}`, error);
    }
  }
  return {completeRecords: true, records, trailingIncomplete: false};
}

async function copyFileRecord({backupRelativePath, category, destinationPath, fsImpl, sourcePath, sourceRelativePath}) {
  const before = await fsImpl.stat(sourcePath);
  await fsImpl.mkdir(path.dirname(destinationPath), {recursive: true});
  await fsImpl.copyFile(sourcePath, destinationPath);
  await fsImpl.chmod(destinationPath, before.mode & 0o777);
  const after = await fsImpl.stat(sourcePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw exportError("source_changed", `Source changed during capture: ${sourceRelativePath}`);
  }
  const copied = await fsImpl.stat(destinationPath);
  return {
    action: "copy",
    category,
    sourcePath: sourceRelativePath,
    backupPath: backupRelativePath,
    byteLength: copied.size,
    mode: copied.mode & 0o777,
    sha256: await hashFile(destinationPath),
  };
}

async function copySafeSymlink({backupRelativePath, category, destinationPath, fsImpl, root, sourcePath, sourceRelativePath}) {
  const target = await fsImpl.readlink(sourcePath);
  const resolvedTarget = path.resolve(path.dirname(sourcePath), target);
  if (path.isAbsolute(target) || !isPathInside(root, resolvedTarget)) {
    return {action: "skip", category, sourcePath: sourceRelativePath, reason: "unsafe-symlink"};
  }
  await fsImpl.mkdir(path.dirname(destinationPath), {recursive: true});
  await fsImpl.symlink(target, destinationPath);
  return {
    action: "copy",
    category,
    kind: "symlink",
    sourcePath: sourceRelativePath,
    backupPath: backupRelativePath,
    byteLength: Buffer.byteLength(target),
    sha256: sha256(Buffer.from(target)),
    target,
  };
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function inventoryField(markdown, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(markdown).match(new RegExp("^- " + escaped + ": `([^\\n]+)`", "m"));
  return match?.[1]?.trim() || "";
}

function normalizeRemotePrefix(value) {
  const raw = String(value || "").trim();
  const clean = raw.startsWith("gs://") ? raw.slice(5).split("/").slice(1).join("/") : raw;
  if (!clean || clean.split("/").some((part) => part === "..")) throw exportError("prefix_invalid", "prefix must be non-empty and must not contain traversal");
  return clean.replace(/^\/+|\/+$/g, "");
}

function prefixesOverlap(left, right) {
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function isChromePath(relative) {
  return CHROME_PATH_PATTERNS.some((pattern) => pattern.test(relative));
}

function resolveInside(root, candidate) {
  const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
  return isPathInside(root, resolved) || resolved === path.resolve(root) ? resolved : null;
}

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function samePath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function exportError(code, message, cause) {
  const error = new Error(message, cause ? {cause} : undefined);
  error.code = code;
  return error;
}
