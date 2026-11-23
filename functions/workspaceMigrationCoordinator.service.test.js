"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createWorkspaceMigrationCoordinator} = require("./workspaceMigrationCoordinator.service");

const evidence = {workspaceId: "workspace-1", operationId: "operation-1"};

test("cutover is ordered and cannot release authority before validation", () => {
  const coordinator = createWorkspaceMigrationCoordinator({now: () => "NOW"});
  let state = coordinator.begin({...evidence, ownerUid: "owner-1", sourceGeneration: "source-1", destinationId: "disk-1"});
  state = coordinator.advance(state, "reserved", evidence);
  state = coordinator.advance(state, "quiescing", evidence);
  state = coordinator.advance(state, "captured", evidence);
  state = coordinator.advance(state, "imported", {...evidence, verified: true});
  state = coordinator.advance(state, "switched", {...evidence, destinationGeneration: "disk-generation-1"});
  assert.throws(() => coordinator.advance(state, "released", evidence), /migration_transition_invalid/);
  state = coordinator.advance(state, "validated", evidence);
  state = coordinator.advance(state, "released", evidence);
  assert.equal(state.authority, "destination");
  assert.equal(state.sourceRetained, true);
});

test("rollback after destination writes blocks unless reverse import is verified", () => {
  const coordinator = createWorkspaceMigrationCoordinator();
  let state = coordinator.begin({...evidence, ownerUid: "owner-1", sourceGeneration: "source-1", destinationId: "disk-1"});
  state = coordinator.advance(state, "reserved", evidence);
  state = coordinator.advance(state, "quiescing", evidence);
  state = coordinator.advance(state, "captured", evidence);
  state = coordinator.advance(state, "imported", {...evidence, verified: true});
  const blocked = coordinator.rollback(state, evidence);
  assert.equal(blocked.state, "blocked");
  const restored = coordinator.rollback(state, {...evidence, destinationWritersStopped: true, reverseImportVerified: true});
  assert.equal(restored.authority, "source");
});
