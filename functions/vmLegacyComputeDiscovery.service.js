"use strict";

const {createHash} = require("node:crypto");

const digest = value => createHash("sha256").update(value).digest("hex");
const MAX_REGIONS = 4;
const MAX_PAGES = 5;

function classifyService(service, {workspaceId, ownerUid, workspace, defaultBucket}) {
  const matchesWorkspaceLabel = service.labels?.["mapache-workspace"] === digest(workspaceId).slice(0, 40);
  const matchesOwnerLabel = service.labels?.["mapache-owner"] === digest(ownerUid).slice(0, 40);
  const bucket = workspace.bucket || workspace.workspaceStorageBucket || defaultBucket;
  const prefix = workspace.storagePrefix || workspace.workspaceStoragePrefix;
  let identified = false;
  for (const container of service.template?.containers || []) {
    const env = new Map((container.env || []).filter(item =>
      ["OWNER_UID", "WORKSPACE_ID", "STORAGE_BUCKET", "STORAGE_PREFIX"].includes(item.name)).map(item => [item.name, item.value]));
    const id = env.get("WORKSPACE_ID");
    const owner = env.get("OWNER_UID");
    if (id === workspaceId) return owner && owner !== ownerUid ? "conflict" : "target";
    if (bucket && prefix && env.get("STORAGE_BUCKET") === bucket && env.get("STORAGE_PREFIX") === prefix) return "prefix_alias";
    if (id && matchesWorkspaceLabel) return "conflict";
    if (id) identified = true;
  }
  if (matchesWorkspaceLabel) return matchesOwnerLabel ? "target" : "conflict";
  if (identified) return "other";
  return /\/(?:session|mpauto)-/.test(service.name || "") ? "unknown_runner" : "other";
}

async function scanRegion(client, projectId, region, identity, knownServices) {
  let inspected = 0;
  const matches = new Map();
  const seen = new Set();
  let unknownRunners = 0;
  let pageToken;
  for (let page = 0; page < MAX_PAGES; page++) {
    const {data} = await client.request({
      url: `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services`,
      method: "GET",
      timeout: 5000,
      params: {pageSize: 100, pageToken, fields: "nextPageToken,unreachable,services(name,labels,template(containers(env(name,value))))"},
    });
    if (!data || data.unreachable?.length || (data.services && !Array.isArray(data.services))) {
      return {inspected, matches, unknownRunners, complete: false};
    }
    for (const service of data.services || []) {
      if (typeof service.name !== "string" || !service.name.includes("/services/")) {
        return {inspected, matches, unknownRunners, complete: false};
      }
      const canonical = service.name.replace(/^projects\/[^/]+\//, `projects/${projectId}/`);
      if (seen.has(canonical)) return {inspected, matches, unknownRunners, complete: false};
      seen.add(canonical);
      inspected++;
      if (knownServices.has(canonical)) {
        matches.set(canonical, "recorded");
        continue;
      }
      const kind = classifyService(service, identity);
      if (kind === "unknown_runner") unknownRunners++;
      else if (kind !== "other") matches.set(canonical, kind);
    }
    if (!data.nextPageToken) return {inspected, matches, unknownRunners, complete: true};
    if (pageToken === data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return {inspected, matches, unknownRunners, complete: false};
}

async function discoverLegacyServices({client, projectId, regions, identity, knownServices}) {
  const blockers = new Set();
  if (regions.length > MAX_REGIONS) blockers.add("legacy_discovery_region_limit_exceeded");
  const observations = await Promise.all(regions.slice(0, MAX_REGIONS).map(async region => {
    try { return await scanRegion(client, projectId, region, identity, knownServices); }
    catch { return {inspected: 0, matches: new Map(), unknownRunners: 0, complete: false}; }
  }));
  if (observations.some(result => !result.complete)) blockers.add("legacy_cloud_run_discovery_incomplete");
  const matches = observations.flatMap(result => [...result.matches]).sort(([a], [b]) => a.localeCompare(b));
  const unknownRunners = observations.reduce((sum, result) => sum + result.unknownRunners, 0);
  if (unknownRunners) blockers.add("legacy_cloud_run_runner_identity_unresolved");
  for (const [, kind] of matches) {
    if (kind === "recorded") blockers.add("legacy_cloud_run_service_present");
    else if (kind === "conflict") blockers.add("legacy_cloud_run_discovery_identity_conflict");
    else if (kind === "prefix_alias") blockers.add("legacy_cloud_run_storage_alias_present");
    else blockers.add("legacy_cloud_run_unrecorded_service_present");
  }
  return {regions: regions.slice(0, MAX_REGIONS), inspectedServices: observations.reduce((sum, result) => sum + result.inspected, 0),
    matchingServices: matches.length, unrecordedMatches: matches.filter(([, kind]) => kind !== "recorded").length,
    unidentifiedRunnerServices: unknownRunners, scannedRegionsClear: blockers.size === 0,
    evidenceSha256: digest(JSON.stringify(matches)), blockers: [...blockers].sort()};
}

module.exports = {discoverLegacyServices};
