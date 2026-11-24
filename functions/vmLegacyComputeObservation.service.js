"use strict";

const {createHash} = require("node:crypto");
const {automationCloudRunServiceId, isValidCloudRunServiceId, resolveCloudRunServiceId} = require("./provisioning.helpers");
const {isAutomationRuntime} = require("./runtimePaths.helpers");
const {discoverLegacyServices} = require("./vmLegacyComputeDiscovery.service");

const MAX_REFERENCES = 96;
const BATCH_SIZE = 16;
const RUN_API = "https://run.googleapis.com/v2/";
const REGION = /^[a-z]+(?:-[a-z0-9]+)+[0-9]$/;

function collectReferences(sessions, {projectId, projectNumber, defaultRegion}) {
  const services = new Set();
  const operations = new Set();
  const blockers = new Set();
  const projectMatches = project => project === projectId || project === projectNumber;
  for (const session of sessions) {
    const region = session.region || defaultRegion;
    if (!REGION.test(region) ||
        (session.serviceId && !isValidCloudRunServiceId(session.serviceId))) {
      blockers.add("legacy_compute_reference_invalid");
      continue;
    }
    const runId = session.automationRunId || session.runId;
    const serviceId = isAutomationRuntime(session) && runId
      ? automationCloudRunServiceId(runId) : resolveCloudRunServiceId(session.id, session.serviceId);
    services.add(`projects/${projectId}/locations/${region}/services/${serviceId}`);
    if (session.serviceName) {
      const named = /^projects\/([^/]+)\/locations\/([^/]+)\/services\/([^/]+)$/.exec(session.serviceName);
      if (!named || !projectMatches(named[1]) || !REGION.test(named[2]) || !isValidCloudRunServiceId(named[3])) {
        blockers.add("legacy_compute_reference_invalid");
      } else {
        services.add(`projects/${projectId}/locations/${named[2]}/services/${named[3]}`);
      }
    }
    if (session.provisioningState === "completed") continue;
    if (!session.provisioningCloudRunOperationName) {
      if (session.provisioningState === "running") blockers.add("legacy_compute_operation_reference_missing");
      continue;
    }
    const operation = /^projects\/([^/]+)\/locations\/([^/]+)\/operations\/([a-zA-Z0-9_-]{1,128})$/.exec(session.provisioningCloudRunOperationName);
    if (!operation || !projectMatches(operation[1]) || !REGION.test(operation[2])) {
      blockers.add("legacy_compute_reference_invalid");
    } else {
      operations.add(`projects/${projectId}/locations/${operation[2]}/operations/${operation[3]}`);
    }
  }
  return {services, operations, blockers};
}

function createVmLegacyComputeObserver({auth, projectId = "pi-agents-cloud", projectNumber, defaultRegion = "us-central1", defaultBucket}) {
  return async (sessions, identity) => {
    const {services, operations, blockers} = collectReferences(sessions, {projectId, projectNumber, defaultRegion});
    const references = [...[...services].map(name => ({name, kind: "service"})),
      ...[...operations].map(name => ({name, kind: "operation"}))].sort((a, b) => a.name.localeCompare(b.name));
    if (references.length > MAX_REFERENCES) blockers.add("legacy_compute_observation_limit_exceeded");
    const observed = [];
    let discovery;
    if (!blockers.size) {
      const client = await auth.getClient();
      const regions = [...new Set([defaultRegion, ...references.map(({name}) => name.split("/")[3])])].sort();
      const discoveryTask = identity && discoverLegacyServices({client, projectId, regions,
        identity: {...identity, defaultBucket}, knownServices: services});
      for (let offset = 0; offset < references.length; offset += BATCH_SIZE) {
        const batch = references.slice(offset, offset + BATCH_SIZE);
        observed.push(...await Promise.all(batch.map(async ({name, kind}) => {
          try {
            const {data} = await client.request({url: RUN_API + name, method: "GET", timeout: 5000});
            if (kind === "service") {
              blockers.add("legacy_cloud_run_service_present");
              return [name, "present"];
            }
            if (data?.done === true) return [name, "terminal"];
            blockers.add("legacy_cloud_run_operation_pending");
            return [name, "pending"];
          } catch (error) {
            const notFound = Number(error.response?.status ?? error.code) === 404;
            if (notFound && kind === "service") return [name, "absent"];
            blockers.add(notFound ? "legacy_cloud_run_operation_unavailable" : "legacy_cloud_run_observation_failed");
            return [name, "unverified"];
          }
        })));
      }
      discovery = await discoveryTask;
    }
    return {referencedServices: services.size, referencedOperations: operations.size,
      absentServices: observed.filter(([, status]) => status === "absent").length,
      terminalOperations: observed.filter(([, status]) => status === "terminal").length,
      recordedComputeClear: blockers.size === 0,
      providerObservationSha256: createHash("sha256").update(JSON.stringify(observed)).digest("hex"),
      ...(discovery ? {discovery} : {}),
      blockers: [...new Set([...blockers, ...(discovery?.blockers || [])])].sort()};
  };
}

module.exports = {createVmLegacyComputeObserver};
