"use strict";

const {createHash} = require("node:crypto");
const {covers, resolveMigrationPrefix} = require("./vmMigrationStorageScope.helpers");

const PAGE_SIZE = 500;
// Keep the observation bounded, but do not reject ordinary workspaces merely
// because their retained prefix has more than 3,000 objects. The coordinator
// writes at most one small inventory row per object and remains below the
// Firestore transaction/write budget at this cap.
const MAX_PAGES = 16;
const CAPTURE_CHUNK_ROWS = 64;
const MAX_CAPTURE_CHUNKS = Math.ceil(PAGE_SIZE * MAX_PAGES / CAPTURE_CHUNK_ROWS);
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const positiveInteger = /^[1-9][0-9]{0,19}$/;
const fail = code => { throw Error(code); };

function storageInventorySha256({bucket, prefix}, ordered) {
  return createHash("sha256").update(JSON.stringify([bucket, prefix, ordered])).digest("hex");
}

function validObjectRow(name, [generation, metageneration, size, crc32c], prefix) {
  return typeof name === "string" && name.startsWith(prefix + "/") && Buffer.byteLength(name) <= 1024 &&
    typeof generation === "string" && positiveInteger.test(generation) &&
    typeof metageneration === "string" && positiveInteger.test(metageneration) &&
    typeof size === "string" && /^(0|[1-9][0-9]*)$/.test(size) && Number.isSafeInteger(Number(size)) &&
    (crc32c === null || (typeof crc32c === "string" && crc32c.length <= 16));
}

function prepareStorageCapture(scope, rows, expectedSha256) {
  if (!Array.isArray(rows) || rows.length > PAGE_SIZE * MAX_PAGES) fail("legacy_storage_capture_invalid");
  let previous = "";
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 2 || !Array.isArray(row[1]) || row[1].length !== 4 ||
        !validObjectRow(row[0], row[1], scope.prefix) || row[0] <= previous) fail("legacy_storage_capture_invalid");
    previous = row[0];
  }
  const chunks = [];
  let bytes = 0;
  for (let index = 0; index < rows.length; index += CAPTURE_CHUNK_ROWS) {
    const json = JSON.stringify(rows.slice(index, index + CAPTURE_CHUNK_ROWS));
    bytes += Buffer.byteLength(json);
    if (bytes > MAX_CAPTURE_BYTES) fail("legacy_storage_capture_too_large");
    chunks.push(json);
  }
  const sha256 = storageInventorySha256(scope, rows);
  if (sha256 !== expectedSha256) fail("legacy_storage_capture_invalid");
  return {sha256, chunks, objectCount: rows.length};
}

function assertSessionScope(sessions, {bucket, prefix}) {
  for (const session of sessions) {
    const sources = [
      [session.workspaceStorageBucket || session.bucket, session.workspaceStoragePrefix],
      [session.homeStorageBucket, session.homeStoragePrefix],
      [session.piSessionStorageBucket, session.piSessionStoragePrefix],
    ];
    if (sources.some(([sourceBucket, sourcePrefix]) =>
      (sourceBucket && sourceBucket !== bucket) || (sourcePrefix && !covers(prefix, sourcePrefix)))) {
      fail("legacy_storage_session_scope_unverified");
    }
  }
}

async function readPrefix(listPage, scope) {
  const objects = new Map();
  const seenTokens = new Set();
  let pageToken;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await listPage({bucketName: scope.bucket, prefix: scope.prefix + "/", pageToken, maxResults: PAGE_SIZE});
    if (!Array.isArray(result.objects) || result.objects.length > PAGE_SIZE ||
        (result.nextPageToken && typeof result.nextPageToken !== "string")) fail("legacy_storage_listing_invalid");
    for (const item of result.objects) {
      if (!item) fail("legacy_storage_listing_invalid");
      const row = [item.generation, item.metageneration, item.size, item.crc32c ?? null];
      if (objects.has(item.name) || !validObjectRow(item.name, row, scope.prefix)) fail("legacy_storage_listing_invalid");
      objects.set(item.name, row);
    }
    if (!result.nextPageToken) {
      const ordered = [...objects].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      return {objects, ordered, digest: storageInventorySha256(scope, ordered)};
    }
    pageToken = result.nextPageToken;
    if (seenTokens.has(pageToken)) fail("legacy_storage_listing_cursor_repeated");
    seenTokens.add(pageToken);
  }
  fail("legacy_storage_listing_limit_exceeded");
}

function createVmMigrationStorageObserver({defaultBucket, listPage}) {
  return async ({workspace, ownerUid, sessions}, {includeInventory = false} = {}) => {
    try {
      const scope = resolveMigrationPrefix(workspace, ownerUid, defaultBucket);
      assertSessionScope(sessions, scope);
      const first = await readPrefix(listPage, scope);
      const second = await readPrefix(listPage, scope);
      const stable = first.digest === second.digest;
      const blockers = stable ? [] : ["legacy_storage_generations_changed"];
      const home = workspace.homePolicy;
      if (home?.mode === "persistent") {
        const actual = home.storagePrefix || scope.prefix + "/.mapache-internal/home";
        const archive = home.archiveName || "home.tar.gz";
        const expected = [actual, actual.replace("/.mapache-internal/", "/.mapahce-internal/"),
          actual.replace("/.mapahce-internal/", "/.mapache-internal/")];
        if (!expected.some(prefix => second.objects.has(prefix + "/" + archive))) blockers.push("legacy_persistent_home_archive_missing");
      }
      return {stable, observedObjects: second.objects.size, firstSha256: first.digest, secondSha256: second.digest, blockers,
        ...(includeInventory && !blockers.length ? {inventory: second.ordered} : {})};
    } catch (error) {
      const errors = ["legacy_storage_listing_invalid", "legacy_storage_listing_cursor_repeated",
        "legacy_storage_listing_limit_exceeded", "legacy_storage_session_scope_unverified"];
      const code = Number(error.code || error.response?.status);
      const reason = error.publicMessage === "vm_migration_storage_scope_unverified" ? error.publicMessage :
        errors.includes(error.message) ? error.message :
        code === 404 ? "legacy_storage_source_not_found" :
        [401, 403].includes(code) ? "legacy_storage_access_denied" : "legacy_storage_observation_failed";
      return {stable: false, blockers: [reason]};
    }
  };
}

module.exports = {createVmMigrationStorageObserver, prepareStorageCapture, MAX_CAPTURE_CHUNKS};
