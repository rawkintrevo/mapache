"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {fork} = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {createRuntimeDescriptor} = require("./runtimeProvider.helpers");
const {createVmLifecycleService, OPERATIONS} = require("./vmLifecycle.service");

function createFileDb(filename) {
  let serial = Promise.resolve();
  const read = async () => JSON.parse(await fs.readFile(filename, "utf8"));
  const snapshot = value => ({exists: value !== undefined, data: () => value === undefined ? undefined : structuredClone(value)});
  const refFor = pathname => ({
    path: pathname,
    collection: id => refFor(`${pathname}/${id}`),
    doc: id => refFor(`${pathname}/${id}`),
    get: async () => snapshot((await read()).docs[pathname]),
  });
  const db = {
    doc: refFor,
    collection: refFor,
    runTransaction(callback) {
      const result = serial.then(async () => {
        const state = await read();
        const changes = [];
        const tx = {
          get: async ref => snapshot(state.docs[ref.path]),
          set: (ref, value) => changes.push(() => { state.docs[ref.path] = structuredClone(value); }),
          update: (ref, value) => changes.push(() => { state.docs[ref.path] = {...state.docs[ref.path], ...structuredClone(value)}; }),
        };
        const output = await callback(tx);
        changes.forEach(apply => apply());
        await fs.writeFile(filename, JSON.stringify(state));
        return output;
      });
      serial = result.catch(() => {});
      return result;
    },
  };
  return {db, read};
}

async function writeState(filename, state) {
  await fs.writeFile(filename, JSON.stringify(state));
}

function lifecycleDependencies(filename, {killBoundary = null} = {}) {
  const fileDb = createFileDb(filename);
  const now = () => 1000;
  const cloud = async () => (await fileDb.read()).cloud;
  const updateCloud = async (update) => {
    const state = await fileDb.read();
    Object.assign(state.cloud, update);
    await writeState(filename, state);
  };
  const killIf = boundary => {
    if (killBoundary === boundary) process.kill(process.pid, "SIGKILL");
  };
  const compute = {
    ensureDataDisk: async () => {},
    pause: async () => {
      const current = await cloud();
      if (current.instancePresent) {
        await updateCloud({instancePresent: false, deleteCalls: current.deleteCalls + 1});
      }
      killIf("pause");
      return {state: "stopped", instanceDeleted: true, dataDiskRetained: true};
    },
    resizeDataDisk: async (descriptor, options) => {
      const current = await cloud();
      if (Number(current.diskSizeGb) < Number(options.sizeGb)) {
        await updateCloud({diskSizeGb: Number(options.sizeGb), resizeCalls: current.resizeCalls + 1});
      }
      killIf("resize");
      return {resized: true, sizeGb: Number(options.sizeGb)};
    },
    start: async () => {
      const current = await cloud();
      if (!current.instancePresent) await updateCloud({instancePresent: true, startCalls: current.startCalls + 1});
      const state = await fileDb.read();
      const workspace = state.docs["vmRuntimes_v2/workspace"];
      workspace.state = "active";
      workspace.bootId = "recovered-boot";
      workspace.leaseExpiresAt = Number.MAX_SAFE_INTEGER;
      state.docs[`vmRuntimes_v2/workspace/sessions/${workspace.currentSessionId}`].state = "active";
      state.docs[`vmRuntimes_v2/workspace/sessions/${workspace.currentSessionId}`].bootId = "recovered-boot";
      state.docs[`vmRuntimes_v2/workspace/sessions/${workspace.currentSessionId}`].leaseExpiresAt = Number.MAX_SAFE_INTEGER;
      await writeState(filename, state);
      killIf("start");
    },
  };
  return {db: fileDb.db, read: fileDb.read, now, compute,
    quiesce: async () => { killIf("quiesce"); return {ok: true}; },
    publishRoute: async () => killIf("route"), health: async () => { killIf("health"); return true; }};
}

async function runChild(filename, operationId, boundary) {
  const service = createVmLifecycleService(lifecycleDependencies(filename, {killBoundary: boundary}));
  const targetPhase = {quiesce: "quiesce", pause: "delete", resize: "provision", start: "provision", route: "route", health: "health"}[boundary];
  while ((await serviceStatus(filename, operationId)).phase !== targetPhase) await service.step(operationId);
  await service.step(operationId);
}

async function serviceStatus(filename, operationId) {
  const {read} = createFileDb(filename);
  const state = await read();
  return state.docs[`${OPERATIONS}/${operationId}`];
}

async function testWorkerCrashRecovery() {
  const boundaries = ["quiesce", "pause", "resize", "start", "route", "health"];
  const expectedPhases = {quiesce: "quiesce", pause: "delete", resize: "provision", start: "provision", route: "route", health: "health"};
  for (const boundary of boundaries) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `mapache-vm-worker-crash-${boundary}-`));
    const filename = path.join(root, "state.json");
    try {
      const descriptor = createRuntimeDescriptor({backend: "compute-engine", workspaceId: "workspace", ownerUid: "owner", generation: 6});
      await writeState(filename, {cloud: {instancePresent: true, diskSizeGb: 64, deleteCalls: 0, resizeCalls: 0, startCalls: 0}, docs: {
        "vmRuntimes_v2/workspace": {ownerUid: "owner", backend: "compute-engine", generation: 6, currentSessionId: "old",
          state: "active", lifecycleEnabled: true, runnerImage: `us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:${"a".repeat(64)}`,
          gatewayHost: "fixture.example.com", machineConfig: {desiredVersion: 1, appliedVersion: 0, state: "pending-restart", desired: {diskSizeGb: 128}}},
        "vmRuntimes_v2/workspace/sessions/old": {ownerUid: "owner", generation: 6, state: "active", runtimeProvider: descriptor,
          piScopedModels: ["selected/model"]},
      }});

      const parentDependencies = lifecycleDependencies(filename);
      const parent = createVmLifecycleService(parentDependencies);
      const {operationId} = await parent.request({workspaceId: "workspace", ownerUid: "owner", requestId: `crash-${boundary}`, action: "replace", expectedGeneration: 6});
      const child = fork(__filename, ["--child", filename, operationId, boundary], {stdio: "ignore"});
      const [code, signal] = await new Promise(resolve => child.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal])));
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");

      const stateAfterKill = await parentDependencies.db.collection(OPERATIONS).doc(operationId).get();
      const operationAfterKill = stateAfterKill.data();
      assert.equal(operationAfterKill.phase, expectedPhases[boundary]);
      assert.equal(operationAfterKill.status, "pending");
      assert.equal(operationAfterKill.claim?.id ? typeof operationAfterKill.claim.id : null, "string");
      assert.equal(operationAfterKill.lastError, null);

      const state = await parentDependencies.db.runTransaction(async tx => {
        const snapshot = await tx.get(parentDependencies.db.collection(OPERATIONS).doc(operationId));
        const value = snapshot.data();
        tx.update(parentDependencies.db.collection(OPERATIONS).doc(operationId), {claim: {...value.claim, expiresAt: 0}});
        return value;
      });
      assert.equal(state.phase, expectedPhases[boundary]);

      for (let attempt = 0; attempt < 10; attempt++) {
        if ((await serviceStatus(filename, operationId)).status !== "pending") break;
        await parent.step(operationId);
      }
      const final = await serviceStatus(filename, operationId);
      const finalState = await parentDependencies.db.collection(OPERATIONS).doc(operationId).get();
      assert.equal(final.status, "succeeded");
      assert.equal(finalState.data().phase, "complete");
      assert.equal(finalState.data().workspaceId, "workspace");
      const recovered = (await parentDependencies.db.collection("vmRuntimes_v2").doc("workspace").get()).data();
      assert.equal(recovered.activeOperationId, null);
      assert.equal(recovered.generation, 7);
      assert.equal(recovered.machineConfig.appliedVersion, 1);
      const afterRecovery = await parentDependencies.read();
      assert.equal(afterRecovery.cloud.deleteCalls, 1, boundary);
      assert.equal(afterRecovery.cloud.resizeCalls, 1, boundary);
      assert.equal(afterRecovery.cloud.startCalls, 1, boundary);
      assert.equal(afterRecovery.cloud.diskSizeGb, 128, boundary);
      assert.equal(afterRecovery.cloud.instancePresent, true, boundary);
    } finally {
      await fs.rm(root, {recursive: true, force: true});
    }
  }
}

if (process.argv[2] === "--child") {
  runChild(process.argv[3], process.argv[4], process.argv[5]).catch(() => process.exit(1));
} else {
  test("a SIGKILL at every lifecycle boundary preserves claims and converges idempotently", testWorkerCrashRecovery);
}
