"use strict";

const {createHash} = require("node:crypto");
const {covers, resolveMigrationPrefix} = require("./vmMigrationStorageScope.helpers");

const PAGE_SIZE = 500;
const MAX_PAGES = 6;
const positiveInteger = /^[1-9][0-9]*$/;
const fail = code => { throw Error(code); };

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
      if (typeof item.name !== "string" || !item.name.startsWith(scope.prefix + "/") || objects.has(item.name) ||
          !positiveInteger.test(item.generation) || !positiveInteger.test(item.metageneration) ||
          !/^(0|[1-9][0-9]*)$/.test(item.size) || !Number.isSafeInteger(Number(item.size))) fail("legacy_storage_listing_invalid");
      objects.set(item.name, [String(item.generation), String(item.metageneration), String(item.size), item.crc32c || null]);
    }
    if (!result.nextPageToken) {
      const ordered = [...objects].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      const digest = createHash("sha256").update(JSON.stringify([scope.bucket, scope.prefix, ordered])).digest("hex");
      return {objects, digest};
    }
    pageToken = result.nextPageToken;
    if (seenTokens.has(pageToken)) fail("legacy_storage_listing_cursor_repeated");
    seenTokens.add(pageToken);
  }
  fail("legacy_storage_listing_limit_exceeded");
}

function createVmMigrationStorageObserver({defaultBucket, listPage}) {
  return async ({workspace, ownerUid, sessions}) => {
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
      return {stable, observedObjects: second.objects.size, firstSha256: first.digest, secondSha256: second.digest, blockers};
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

module.exports = {createVmMigrationStorageObserver};
