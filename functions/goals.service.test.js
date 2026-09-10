"use strict";

const assert = require("node:assert/strict");
const {createGoalsService} = require("./goals.service");

class FakeDoc {
  constructor(collection, id) { this.collectionRef = collection; this.id = id; this.ref = this; }
  get parent() { return this.collectionRef; }
  collection(name) { return this[name] || (this[name] = new FakeCollection(this, name)); }
  data() { return this.collectionRef.store.get(this.id) || {}; }
  async get() { return {exists: this.collectionRef.store.has(this.id), id: this.id, ref: this, data: () => this.data()}; }
  async set(value) { this.collectionRef.store.set(this.id, {...value}); }
  async update(value) {
    const current = {...this.data()};
    for (const [key, item] of Object.entries(value)) {
      const parts = key.split(".");
      let target = current;
      for (const part of parts.slice(0, -1)) target = target[part] = {...(target[part] || {})};
      target[parts.at(-1)] = item;
    }
    this.collectionRef.store.set(this.id, current);
  }
}

class FakeCollection {
  constructor(parent = null, name = "") { this.parent = parent; this.name = name; this.store = new Map(); this.docs = new Map(); }
  doc(id = `generated-${this.store.size + 1}`) {
    if (!this.docs.has(id)) this.docs.set(id, new FakeDoc(this, id));
    return this.docs.get(id);
  }
  collection(name) { const collection = new FakeCollection(this.doc("parent"), name); this[name] = collection; return collection; }
  orderBy() { return this; }
  limit() { return this; }
  async get() { return {docs: [...this.store.keys()].map((id) => ({id, ref: this.doc(id), data: () => this.store.get(id)}))}; }
}

function createDb() {
  const root = new FakeCollection();
  const workspaces = new FakeCollection(root, "workspaces");
  root.collection = (name) => name === "workspaces" ? workspaces : new FakeCollection(root, name);
  const workspace = workspaces.doc("workspace-1");
  workspace.goals = new FakeCollection(workspace, "goals");
  workspace.goalOperations = new FakeCollection(workspace, "goalOperations");
  workspace.collection = (name) => workspace[name] || (workspace[name] = new FakeCollection(workspace, name));
  workspaces.doc = (id) => id === "workspace-1" ? workspace : new FakeDoc(workspaces, id);
  return root;
}

(async () => {
  const db = createDb();
  const service = createGoalsService({
    db,
    admin: {firestore: {FieldValue: {serverTimestamp: () => "timestamp"}}},
    requireWorkspace: async () => ({}),
    requireSession: async () => ({sessionSnap: {data: () => ({harnessId: "shell"})}}),
  });
  const goal = await service.createGoal("uid", "workspace-1", {objective: "Document the release"});
  assert.equal(goal.lifecycle, "draft");
  const listed = await service.listGoals("uid", "workspace-1");
  assert.equal(listed.goals.length, 1);
  await assert.rejects(service.actionGoal("uid", "workspace-1", goal.id, {action: "start", expectedRevision: 0}), (error) => error.publicMessage === "goal_session_required");

  const runnerCalls = [];
  const executableService = createGoalsService({
    db,
    admin: {firestore: {FieldValue: {serverTimestamp: () => "timestamp"}}},
    requireWorkspace: async () => ({}),
    requireSession: async () => ({sessionSnap: {data: () => ({
      harnessId: "pi",
      serviceUrl: "https://runner.example",
      shutdownToken: "token",
      syncWriterRole: "writer",
    })}}),
    requestRunnerJson: async (_session, route, options) => {
      runnerCalls.push({route, options});
      if (route === "/goals/snapshot") return {ok: true, goals: [], runtime: {status: "waiting_for_input", pendingUiRequests: [{id: "question-1", method: "confirm"}]}};
      return {accepted: true, goalId: "engine-goal-1"};
    },
  });
  const started = await executableService.actionGoal("uid", "workspace-1", goal.id, {
    action: "start", expectedRevision: 0, operationId: "start-1", sessionId: "session-1", takeOverTerminal: true,
  });
  assert.equal(started.goal.lifecycle, "open");
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].route, "/goals/commands");
  assert.equal(runnerCalls[0].options.body.payload.takeOverTerminal, true);
  const retried = await executableService.actionGoal("uid", "workspace-1", goal.id, {
    action: "start", expectedRevision: 0, operationId: "start-1", sessionId: "session-1", takeOverTerminal: true,
  });
  assert.equal(retried.operationId, "start-1");
  assert.equal(runnerCalls.length, 1, "retries return the stored operation result");
  const runtime = await executableService.getGoalRuntime("uid", "workspace-1", goal.id);
  assert.equal(runtime.ok, true);
  assert.equal(runtime.runtime.pendingUiRequests[0].id, "question-1");

  const answered = await executableService.answerGoalQuestion("uid", "workspace-1", goal.id, "question-1", {requestId: "question-1", answer: "Yes", expectedRevision: 1});
  assert.equal(answered.goal.revision, 2);

  const archived = await executableService.actionGoal("uid", "workspace-1", goal.id, {
    action: "archive", expectedRevision: 2, operationId: "archive-1", sessionId: "session-1",
  });
  assert.equal(archived.goal.lifecycle, "archived");
  await assert.rejects(executableService.actionGoal("uid", "workspace-1", goal.id, {
    action: "start", expectedRevision: 3, operationId: "start-archived", sessionId: "session-1",
  }), (error) => error.publicMessage === "invalid_goal_transition");
  assert.equal(runnerCalls.filter((call) => call.route === "/goals/commands").length, 3, "invalid transitions must not reach the runner");
  const events = await executableService.listGoalEvents("uid", "workspace-1", goal.id);
  assert.ok(events.events.some((event) => event.type === "goal_action_applied"));
  console.log("goals service tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
