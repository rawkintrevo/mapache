"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createAutomationProvisioningService,
  stableAutomationFailureCode,
} = require("./automationProvisioning.service");
const {automationCloudRunServiceId} = require("./provisioning.helpers");

const admin = {
  firestore: {
    FieldValue: {
      serverTimestamp: () => "SERVER_TIMESTAMP",
    },
  },
};

class Ref {
  constructor(db, path, id) {
    this.db = db;
    this.path = path;
    this.id = id;
  }

  async get() {
    const value = this.db.data.get(this.path);
    return {exists: value !== undefined, id: this.id, ref: this, data: () => value};
  }

  async update(updates) {
    const before = this.db.data.get(this.path);
    const after = {...(before || {}), ...updates};
    this.db.data.set(this.path, after);
    this.db.events.push({path: this.path, data: {
      before: {id: this.id, exists: Boolean(before), data: () => before},
      after: {id: this.id, exists: true, data: () => after},
    }});
  }

  collection(name) {
    return new Collection(this.db, `${this.path}/${name}`);
  }
}

class Collection {
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }

  doc(id) {
    return new Ref(this.db, `${this.path}/${id}`, id);
  }
}

class Db {
  constructor() {
    this.data = new Map();
    this.events = [];
  }

  collection(name) {
    return new Collection(this, name);
  }

  async runTransaction(callback) {
    const transaction = {
      get: (ref) => ref.get(),
      update: (ref, updates) => ref.update(updates),
    };
    return callback(transaction);
  }
}

function baseRun(overrides = {}) {
  return {
    runId: "run-1",
    ownerUid: "user-1",
    workspaceId: "workspace-1",
    automationId: "automation-1",
    status: "provisioning",
    cleanupState: "pending",
    createdAt: "2026-09-22T20:40:50.000Z",
    snapshot: {
      name: "Daily report",
      prompt: "private prompt must never enter the runner environment",
      definitionRevision: 1,
      cron: "0 10 * * *",
      timezone: "America/Chicago",
      allowParallelWithMain: true,
      modelSelection: null,
      resources: {cpu: "2", memory: "4Gi"},
    },
    ...overrides,
  };
}

function setup({run = baseRun(), existingSession, pending = false} = {}) {
  const db = new Db();
  db.data.set("automationRuns/run-1", run);
  db.data.set("workspaces/workspace-1", {
    ownerUid: "user-1",
    canonicalSessionId: "main-session",
    resources: {cpu: "1", memory: "1Gi"},
  });
  if (existingSession) db.data.set("workspaces/workspace-1/sessions/auto-run-1", existingSession);

  const calls = [];
  const service = createAutomationProvisioningService({
    admin,
    createSession: async (uid, workspaceId, payload) => {
      calls.push({kind: "createSession", uid, workspaceId, payload});
      const sessionId = "auto-run-1";
      db.data.set(`workspaces/${workspaceId}/sessions/${sessionId}`, {
        ownerUid: uid,
        workspaceId,
        runnerSessionId: sessionId,
        runtimeKind: "automation",
        automationRunId: payload.runId,
        serviceId: automationCloudRunServiceId(payload.runId),
        serviceName: `projects/test/locations/us-central1/services/${automationCloudRunServiceId(payload.runId)}`,
        provisioningOperationId: payload.operationId,
        status: "provisioning",
        imageKey: "pi-chrome",
        image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome",
        harnessId: "pi",
        terminalKind: "pi",
        sessionType: "cloud",
        resources: payload.resources,
      });
      return {id: sessionId};
    },
    db,
    featureEnabled: async () => true,
    provisionSessionService: async (workspace, sessionRef, session) => {
      calls.push({kind: "provision", workspace, session});
      if (!pending) await sessionRef.update({status: "running", serviceUrl: "https://automation.example.run.app"});
    },
    requireWorkspace: async () => db.collection("workspaces").doc("workspace-1").get().then((snap) => ({id: "workspace-1", ...snap.data()})),
    sessionCollection: (workspaceId) => db.collection("workspaces").doc(workspaceId).collection("sessions"),
  });
  return {calls, db, service};
}

test("claims and provisions an admitted run without changing the canonical main session", async () => {
  const {calls, db, service} = setup();
  const result = await service.provisionAutomationRun("run-1");
  assert.deepEqual(result, {provisioned: true, runId: "run-1", sessionId: "auto-run-1"});
  assert.equal(db.data.get("automationRuns/run-1").status, "running");
  assert.equal(db.data.get("automationRuns/run-1").sessionId, "auto-run-1");
  assert.equal(db.data.get("workspaces/workspace-1").canonicalSessionId, "main-session");
  assert.equal(calls.filter((call) => call.kind === "createSession").length, 1);
  assert.equal(calls.find((call) => call.kind === "createSession").payload.runtimeKind, "automation");
  assert.equal(calls.find((call) => call.kind === "createSession").payload.resources.memory, "4Gi");
  assert.equal(calls.find((call) => call.kind === "createSession").payload.automationRunAt,
      "2026-09-22T20:40:50.000Z");
  assert.equal(calls.find((call) => call.kind === "createSession").payload.automationTimezone, "America/Chicago");

  const repeated = await service.provisionAutomationRun("run-1");
  assert.deepEqual(repeated, {skipped: "status_running", runId: "run-1"});
  assert.equal(calls.filter((call) => call.kind === "provision").length, 1);
});

test("routes an identity mismatch to failed cleanup while retaining the run slot", async () => {
  const {db, service} = setup({existingSession: {
    ownerUid: "user-1",
    workspaceId: "workspace-1",
    runtimeKind: "automation",
    automationRunId: "different-run",
    serviceId: automationCloudRunServiceId("run-1"),
    status: "provisioning",
    imageKey: "pi-chrome",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome",
    harnessId: "pi",
    terminalKind: "pi",
  }});
  const result = await service.provisionAutomationRun("run-1");
  assert.equal(result.provisioned, false);
  const run = db.data.get("automationRuns/run-1");
  assert.equal(run.status, "failed");
  assert.equal(run.cleanupState, "pending");
  assert.equal(run.desiredOutcome, "failed");
  assert.equal(run.provisioningErrorCode, "automation_session_identity_mismatch");
});

test("uses stable failure codes and does not serialize arbitrary provider errors", () => {
  assert.equal(stableAutomationFailureCode({message: "quota exhausted for secret token"}), "cloud_run_quota_exceeded");
  assert.equal(stableAutomationFailureCode({message: "provider returned a bearer token"}), "automation_provisioning_failed");
});

test("pending provisioning does not generate a recursive Firestore event loop", async () => {
  const {calls, db, service} = setup({pending: true});
  await service.handleAutomationRunEvent({data: {
    before: {exists: true, data: () => baseRun({status: "queued"})},
    after: {id: "run-1", exists: true, data: () => baseRun()},
  }});
  assert.equal(db.events.length, 2);
  for (let i = 0; i < db.events.length; i++) {
    assert.ok(i < 10, "self-generated writes must stop");
    await service.handleAutomationRunEvent(db.events[i]);
  }
  assert.equal(calls.filter((call) => call.kind === "provision").length, 1);

  // Reconciliation can still resume a lost/pending attempt without rewriting
  // its claim or attachment on every minute tick.
  await service.provisionAutomationRun("run-1");
  assert.equal(calls.filter((call) => call.kind === "provision").length, 2);
  assert.equal(db.events.length, 2);
});

test("session worker ignores progress writes but reconciles a completed provision", async () => {
  const {calls, db, service} = setup({pending: true});
  await service.provisionAutomationRun("run-1");
  const sessionPath = "workspaces/workspace-1/sessions/auto-run-1";
  const session = db.data.get(sessionPath);
  const event = (before, after) => ({data: {
    before: {exists: true, data: () => before},
    after: {id: "auto-run-1", exists: true, data: () => after},
  }});
  await service.handleAutomationSessionEvent(event(session, {...session, provisioningState: "running"}));
  assert.equal(calls.filter((call) => call.kind === "provision").length, 1);
  const running = {...session, status: "running", serviceUrl: "https://automation.example.run.app"};
  db.data.set(sessionPath, running);
  await service.handleAutomationSessionEvent(event(session, running));
  assert.equal(db.data.get("automationRuns/run-1").status, "running");
  const writes = db.events.length;
  await service.handleAutomationSessionEvent(event(running, {...running, heartbeat: 1}));
  assert.equal(db.events.length, writes);
});

console.log("automation provisioning service tests passed");
