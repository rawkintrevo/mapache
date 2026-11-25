"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {Transform} = require("node:stream");
const {pipeline} = require("node:stream/promises");

const MAX_UPLOAD_BYTES = 1024 ** 3;

function createDiskUploadService({config, fsImpl = fs, maxBytes = MAX_UPLOAD_BYTES, now = () => new Date().toISOString()} = {}) {
  const root = path.resolve(config?.retainedDiskPaths?.uploads || path.join(config?.workspaceDir || "/workspace", "uploads"));
  const stateRoot = path.resolve(config?.retainedDiskPaths?.caches || path.join(config?.workspaceDir || "/workspace", ".mapache-internal", "uploads"));
  const operationLocks = new Map();

  return {begin, append, cancel, handle};

  async function handle(req, res) {
    const operationId = safeId(req.params.operationId);
    if (req.method === "DELETE") {
      await cancel(operationId);
      res.status(204).send();
      return;
    }
    const name = req.query.name;
    const size = Number(req.query.size);
    try {
      const range = parseContentRange(req.get("content-range"));
      const operation = await begin({operationId, name, size, expectedSha256: req.get("x-upload-sha256") || ""});
      if (range.probe) {
        if (operation.state === "committed") {
          res.json({ok: true, path: `/uploads/${operation.name}`});
          return;
        }
        const offset = await currentOffset(operation);
        res.status(308).set("Range", offset ? `bytes=0-${offset - 1}` : "").send();
        return;
      }
      if (range.total !== operation.size || range.start !== await currentOffset(operation)) {
        res.status(409).json({error: "upload_offset_conflict"});
        return;
      }
      const result = await append(operationId, req, range);
      if (result.complete) {
        res.json({ok: true, path: `/uploads/${operation.name}`});
      } else {
        res.status(308).set("Range", `bytes=0-${result.offset - 1}`).send();
      }
    } catch (error) {
      res.status(error.status || 400).json({error: error.publicMessage || error.code || "upload_failed"});
    }
  }

  async function begin({operationId, name, size, expectedSha256 = ""} = {}) {
    const id = safeId(operationId || crypto.randomUUID());
    return withOperationLock(id, async () => {
      const normalizedName = validateName(name);
      const total = validateSize(size, maxBytes);
      await fsImpl.promises.mkdir(root, {recursive: true, mode: 0o700});
      await fsImpl.promises.mkdir(stateRoot, {recursive: true, mode: 0o700});
      const statePath = path.join(stateRoot, `${id}.json`);
      const temporaryPath = path.join(root, `.${id}.part`);
      const destinationPath = path.join(root, normalizedName);
      const existing = await readJson(statePath);
      if (existing) {
        if (existing.name !== normalizedName || Number(existing.size) !== total) throw uploadError("upload_operation_conflict");
        return existing;
      }
      const operation = {
        operationId: id,
        name: normalizedName,
        size: total,
        expectedSha256: normalizeHash(expectedSha256),
        temporaryPath,
        destinationPath,
        state: "receiving",
        createdAt: now(),
        updatedAt: now(),
      };
      await writeJson(statePath, operation);
      return operation;
    });
  }

  async function append(operationId, source, range) {
    return withOperationLock(operationId, async () => {
      const operation = await requireOperation(operationId);
      if (operation.state !== "receiving") throw uploadError("upload_not_receiving");
      const offset = await currentOffset(operation);
      if (offset !== range.start) throw uploadError("upload_offset_conflict");
      let received = 0;
      try {
        await pipeline(source, new Transform({
          transform(chunk, encoding, callback) {
            received += chunk.length;
            callback(null, chunk);
          },
        }), fsImpl.createWriteStream(operation.temporaryPath, {
          flags: appendFlags(fsImpl), mode: 0o600,
        }));
      } catch (error) {
        const partialOffset = await currentOffset(operation);
        if (error.code === "ELOOP") {
          // Never truncate a path that failed O_NOFOLLOW: truncate follows a
          // symlink, while rm removes only the directory entry.
          await fsImpl.promises.rm(operation.temporaryPath, {force: true});
        } else if (partialOffset < offset || partialOffset > operation.size) {
          await truncate(operation.temporaryPath, offset);
        } else if (partialOffset !== offset) {
          await writeJson(statePathFor(operation), {...operation, updatedAt: now()});
        }
        throw normalizeUploadError(error);
      }
      const expectedBytes = range.end - range.start + 1;
      const nextOffset = await currentOffset(operation);
      if (received !== expectedBytes || nextOffset > operation.size || nextOffset !== range.end + 1) {
        await truncate(operation.temporaryPath, offset);
        throw uploadError("upload_size_mismatch");
      }
      if (nextOffset < operation.size) {
        await writeJson(statePathFor(operation), {...operation, updatedAt: now()});
        return {complete: false, offset: nextOffset};
      }
      const digest = await sha256(operation.temporaryPath);
      if (operation.expectedSha256 && digest !== operation.expectedSha256) throw uploadError("upload_checksum_mismatch");
      try {
        await fsImpl.promises.access(operation.destinationPath);
        throw uploadError("upload_filename_already_exists_rename_file", 412);
      } catch (error) {
        if (error.publicMessage) throw error;
        if (error.code !== "ENOENT") throw error;
      }
      await fsImpl.promises.rename(operation.temporaryPath, operation.destinationPath);
      await writeJson(statePathFor(operation), {...operation, state: "committed", digest, committedAt: now(), updatedAt: now()});
      return {complete: true, offset: nextOffset};
    });
  }

  async function cancel(operationId) {
    return withOperationLock(operationId, async () => {
      const operation = await readJson(statePathForId(operationId));
      if (!operation) return;
      await fsImpl.promises.rm(operation.temporaryPath, {force: true});
      await fsImpl.promises.rm(statePathFor(operation), {force: true});
    });
  }

  async function requireOperation(operationId) {
    const operation = await readJson(statePathForId(operationId));
    if (!operation) throw uploadError("upload_expired", 404);
    return operation;
  }

  async function currentOffset(operation) {
    try {
      const stat = await fsImpl.promises.lstat(operation.temporaryPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        await fsImpl.promises.rm(operation.temporaryPath, {force: true});
        throw uploadError("upload_temporary_path_invalid", 409);
      }
      return stat.size;
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
  }

  async function sha256(target) {
    const hash = crypto.createHash("sha256");
    for await (const chunk of fsImpl.createReadStream(target)) hash.update(chunk);
    return hash.digest("hex");
  }

  async function truncate(target, size) {
    try { await fsImpl.promises.truncate(target, size); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async function withOperationLock(operationId, work) {
    const previous = operationLocks.get(operationId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    operationLocks.set(operationId, current);
    await previous;
    try { return await work(); } finally {
      release();
      if (operationLocks.get(operationId) === current) operationLocks.delete(operationId);
    }
  }

  function statePathFor(operation) { return path.join(stateRoot, `${operation.operationId}.json`); }
  function statePathForId(operationId) { return path.join(stateRoot, `${safeId(operationId)}.json`); }
  async function readJson(target) {
    try { return JSON.parse(await fsImpl.promises.readFile(target, "utf8")); } catch (error) { return error.code === "ENOENT" ? null : Promise.reject(error); }
  }
  async function writeJson(target, value) {
    const temporary = `${target}.tmp`;
    await fsImpl.promises.writeFile(temporary, `${JSON.stringify(value)}\n`, {mode: 0o600});
    await fsImpl.promises.rename(temporary, target);
  }
}

function appendFlags(fsImpl) {
  const constants = fsImpl.constants || fs.constants;
  if (typeof constants.O_NOFOLLOW !== "number") return "a";
  return constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
}

function normalizeUploadError(error) {
  if (error?.publicMessage) return error;
  if (error?.code === "ENOSPC") return uploadError("upload_storage_full", 507);
  if (error?.code === "ELOOP") return uploadError("upload_temporary_path_invalid", 409);
  return error;
}

function parseContentRange(value) {
  const raw = String(value || "").trim();
  const probeMatch = /^bytes \*\/(\d+)$/.exec(raw);
  if (probeMatch) return {probe: true, total: Number(probeMatch[1])};
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(raw);
  if (!match) throw uploadError("upload_range_invalid");
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total) || end < start) throw uploadError("upload_range_invalid");
  return {start, end, total};
}

function validateName(value) {
  const name = String(value || "").trim();
  if (!name || name === "." || name === ".." || /[/\\\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 240) throw uploadError("invalid_upload_filename");
  return name;
}

function validateSize(value, maxBytes) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) throw uploadError("upload_size_invalid");
  return size;
}

function normalizeHash(value) {
  const hash = String(value || "").trim().toLowerCase();
  return hash && /^[a-f0-9]{64}$/.test(hash) ? hash : "";
}

function safeId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw uploadError("upload_operation_invalid");
  return id;
}

function uploadError(code, status = 409) {
  const error = new Error(code);
  error.code = code;
  error.publicMessage = code;
  error.status = status;
  return error;
}

module.exports = {
  MAX_UPLOAD_BYTES,
  createDiskUploadService,
  parseContentRange,
  validateName,
  validateSize,
  normalizeUploadError,
};
