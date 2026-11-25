import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDestinationRuntimeReady,
  createDestinationSeed,
  destinationReservationNeedsReset,
  parseDestinationRuntimeArgs,
  parseGatewayUrl,
} from "./vm-migration-destination-runtime.mjs";

const image = `us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:${"a".repeat(64)}`;

test("destination runtime parser requires explicit project and action confirmation", () => {
  const parsed = parseDestinationRuntimeArgs(["start", "--project", "pi-agents-cloud", "--workspace", "workspace-605",
    "--owner", "owner-605", "--operation", "operation-605", "--runner-image", image,
    "--confirm", "destination-start"]);
  assert.equal(parsed.action, "start");
  assert.equal(parsed.options.get("--runner-image"), image);
  assert.throws(() => parseDestinationRuntimeArgs(["cleanup", "--project", "pi-agents-cloud", "--workspace", "workspace-605",
    "--owner", "owner-605", "--operation", "operation-605", "--confirm", "destination-start"]),
  /destination_runtime_arguments_invalid/);
});

test("gateway parser accepts only an exact HTTPS Cloud Run origin", () => {
  assert.equal(parseGatewayUrl("https://mapache-vm-gateway-v2-abc-uc.a.run.app/").host,
    "mapache-vm-gateway-v2-abc-uc.a.run.app");
  assert.throws(() => parseGatewayUrl("https://mapache-vm-gateway-v2-abc-uc.a.run.app/healthz"),
    /destination_gateway_url_invalid/);
  assert.throws(() => parseGatewayUrl("http://mapache-vm-gateway-v2-abc-uc.a.run.app"),
    /destination_gateway_url_invalid/);
});

test("destination seed binds the normal runtime to the imported disk while hidden", () => {
  const seed = createDestinationSeed({workspaceId: "workspace-605", ownerUid: "owner-605", operationId: "operation-605",
    sourceGeneration: 7, destination: {region: "us-central1", zone: "us-central1-a", generation: 8,
      diskName: "mapache-ws-imported-605", diskId: "123"}, runnerImage: image,
    gatewayHost: "mapache-vm-gateway-v2-abc-uc.a.run.app", nowMs: 123});
  assert.equal(seed.descriptor.dataDiskName, "mapache-ws-imported-605");
  assert.equal(seed.descriptor.generation, 8);
  assert.equal(seed.runtime.apiEnabled, false);
  assert.equal(seed.runtime.migrationAuthority, "legacy");
  assert.equal(seed.route.enabled, false);
  assert.equal(seed.session.runtimeProvider.instanceName, seed.descriptor.instanceName);
  assert.equal(seed.credentials.controlToken.length, 64);
  assert.equal(seed.session.controlTokenHash.length, 64);
  assert.equal(seed.operation.sourceGeneration, 7);
  assert.equal(seed.operation.destinationGeneration, 8);
});

test("ready attestation requires the operation-owned hidden runtime to still be active", () => {
  const input = {workspaceId: "workspace-605", ownerUid: "owner-605", operationId: "operation-605"};
  const operation = {workspaceId: input.workspaceId, ownerUid: input.ownerUid, operationId: input.operationId,
    phase: "disk-import-verified", destinationRuntime: {state: "reserved", sessionId: "session-605", gatewayHost: "gateway.run.app"}};
  const runtime = {ownerUid: input.ownerUid, backend: "compute-engine", migrationOperationId: input.operationId,
    apiEnabled: false, migrationAuthority: "legacy", state: "active", generation: 8,
    currentSessionId: "session-605", gatewayHost: "gateway.run.app"};
  const session = {ownerUid: input.ownerUid, generation: 8, state: "active"};
  const route = {workspaceId: input.workspaceId, ownerUid: input.ownerUid, migrationOperationId: input.operationId,
    generation: 8, sessionId: "session-605", enabled: true, migrationAuthority: "legacy"};
  assert.doesNotThrow(() => assertDestinationRuntimeReady({operation, runtime, session, route, input,
    health: {status: 200, agentReady: true}}));
  assert.throws(() => assertDestinationRuntimeReady({operation, runtime: {...runtime, apiEnabled: true}, session, route, input,
    health: {status: 200, agentReady: true}}), /destination_runtime_authority_changed/);
  assert.throws(() => assertDestinationRuntimeReady({operation, runtime, session, route: {...route, enabled: false}, input,
    health: {status: 200, agentReady: true}}), /destination_runtime_authority_changed/);
});

test("a partial stop resets reservation state before retrying an existing VM", () => {
  assert.equal(destinationReservationNeedsReset({runtime: {state: "reserved"}, session: {state: "reserved"}, route: {enabled: false}}), false);
  assert.equal(destinationReservationNeedsReset({runtime: {state: "active"}, session: {state: "active"}, route: {enabled: true}}), false);
  assert.equal(destinationReservationNeedsReset({runtime: {state: "stopping"}, session: {state: "active"}, route: {enabled: true}}), true);
  assert.equal(destinationReservationNeedsReset({runtime: {state: "reserved"}, session: {state: "reserved"}, route: {enabled: true}}), true);
});
