import {createHash, randomBytes} from "node:crypto";

export const PROJECT_ID = "pi-agents-cloud";
export const REGION = "us-central1";
export const SUBNETWORK = "projects/pi-agents-cloud/regions/us-central1/subnetworks/mapache-vm-v2-us-central1";
export const CONTROL_URL = `https://${REGION}-${PROJECT_ID}.cloudfunctions.net/vmRuntimeControl_v2`;
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const RUNNER_IMAGE = /^us-central1-docker\.pkg\.dev\/pi-agents-cloud\/pi-agents\/session-runner@sha256:[a-f0-9]{64}$/;

const ACTIONS = new Set(["start", "cleanup"]);
const FLAGS = new Set(["--project", "--workspace", "--owner", "--operation", "--runner-image", "--gateway-url", "--confirm"]);

function invalid(code) {
  throw Error(code);
}

export function parseDestinationRuntimeArgs(argv = []) {
  const values = [...argv];
  const action = values.shift();
  if (!ACTIONS.has(action)) invalid("destination_runtime_action_invalid");
  const options = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!FLAGS.has(flag) || !value || options.has(flag)) invalid("destination_runtime_arguments_invalid");
    options.set(flag, value);
  }
  const required = ["--project", "--workspace", "--owner", "--operation", "--confirm"];
  if (!required.every(flag => options.has(flag)) || options.get("--project") !== PROJECT_ID ||
      !["--workspace", "--owner", "--operation"].every(flag => IDENTIFIER.test(options.get(flag) || "")) ||
      options.get("--confirm") !== `destination-${action}`) {
    invalid("destination_runtime_arguments_invalid");
  }
  if (action === "start" && !RUNNER_IMAGE.test(options.get("--runner-image") || "")) {
    invalid("destination_runtime_image_invalid");
  }
  if (action === "cleanup" && (options.has("--runner-image") || options.has("--gateway-url"))) {
    invalid("destination_runtime_arguments_invalid");
  }
  return {action, options};
}

export function parseGatewayUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    invalid("destination_gateway_url_invalid");
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".run.app") || url.username || url.password ||
      url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    invalid("destination_gateway_url_invalid");
  }
  return {url, host: url.hostname};
}

export function destinationSessionId(operationId, generation) {
  return `vm-migration-${createHash("sha256").update(String(operationId)).digest("hex").slice(0, 24)}-g${generation}`;
}

function instanceName(workspaceId, generation) {
  return `mapache-vm-${createHash("sha256").update(`${workspaceId}:${generation}`).digest("hex").slice(0, 24)}`;
}

function token() {
  return randomBytes(32).toString("hex");
}

function tokenHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function createDestinationSeed({workspaceId, ownerUid, operationId, sourceGeneration, destination, runnerImage, gatewayHost, nowMs = Date.now()}) {
  const sessionId = destinationSessionId(operationId, destination.generation);
  const credentials = {ownerUid, generation: destination.generation, controlToken: token(), browserToken: token(), shutdownToken: token()};
  const descriptor = {
    version: 1,
    backend: "compute-engine",
    workspaceId,
    ownerUid,
    region: destination.region,
    zone: destination.zone,
    generation: destination.generation,
    dataDiskName: destination.diskName,
    instanceName: instanceName(workspaceId, destination.generation),
    gateway: null,
    state: "reserved",
    desiredConfigVersion: 0,
  };
  return {
    sessionId,
    descriptor,
    credentials,
    runtime: {
      ownerUid,
      backend: "compute-engine",
      generation: destination.generation,
      state: "reserved",
      currentSessionId: sessionId,
      apiEnabled: false,
      lifecycleEnabled: false,
      runnerImage,
      gatewayHost,
      activeOperationId: null,
      migrationOperationId: operationId,
      migrationAuthority: "legacy",
      migrationSourceGeneration: sourceGeneration,
      migrationDestinationGeneration: destination.generation,
      bootId: null,
      leaseExpiresAt: 0,
      destinationRuntimeCreatedAtMs: nowMs,
    },
    session: {
      ownerUid,
      generation: destination.generation,
      state: "reserved",
      runtimeProvider: descriptor,
      authSelection: {harness: "pi", providers: {}},
      piScopedModels: [],
      environmentEntryIds: [],
      controlTokenHash: tokenHash(credentials.controlToken),
    },
    route: {
      ownerUid,
      workspaceId,
      generation: destination.generation,
      sessionId,
      enabled: false,
      migrationOperationId: operationId,
      migrationAuthority: "legacy",
    },
    operation: {
      version: 1,
      state: "reserved",
      sourceGeneration,
      destinationGeneration: destination.generation,
      sessionId,
      gatewayHost,
      runnerImage,
      createdAtMs: nowMs,
    },
  };
}

export function safeDestinationStatus({workspaceId, operationId, destinationGeneration, sessionId, state, health = false}) {
  return {status: health ? "ready" : "reserved", workspaceId, operationId, destinationGeneration, sessionId,
    state, apiEnabled: false, sourceRetained: true, destinationDiskRetained: true,
    readyForCutoverReview: health};
}
