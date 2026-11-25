"use strict";

const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const fs = require("node:fs/promises");
const test = require("node:test");
const os = require("node:os");
const path = require("node:path");
const {createWorkspaceMigrationCoordinator, REVERSE_IMPORT_FORMAT} = require("./workspaceMigrationCoordinator.service");

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
  state = coordinator.advance(state, "imported", {...evidence, verified: true, destinationGeneration: "disk-generation-1"});
  const blocked = coordinator.rollback(state, evidence);
  assert.equal(blocked.state, "blocked");
  const restored = coordinator.rollback(state, {
    ...evidence, destinationWritersStopped: true, reverseImportVerified: true,
    reverseImport: {format: REVERSE_IMPORT_FORMAT, operationId: evidence.operationId,
      sourceGeneration: "source-1", destinationGeneration: "disk-generation-1", sha256: "a".repeat(64)},
  });
  assert.equal(restored.authority, "source");
  assert.equal(restored.rollback.destinationRetained, true);
});

test("rollback rejects an unbound or unsupported reverse import receipt", () => {
  const coordinator = createWorkspaceMigrationCoordinator();
  let state = coordinator.begin({...evidence, ownerUid: "owner-1", sourceGeneration: "source-1", destinationId: "disk-1"});
  state = coordinator.advance(state, "reserved", evidence);
  state = coordinator.advance(state, "quiescing", evidence);
  state = coordinator.advance(state, "captured", evidence);
  state = coordinator.advance(state, "imported", {...evidence, verified: true, destinationGeneration: "disk-generation-1"});

  const unsupported = coordinator.rollback(state, {
    ...evidence, destinationWritersStopped: true, reverseImportVerified: true,
    reverseImport: {format: "old-checkpoint-flip", operationId: evidence.operationId,
      sourceGeneration: "source-1", destinationGeneration: "disk-generation-1", sha256: "a".repeat(64)},
  });
  assert.equal(unsupported.state, "blocked");
  assert.equal(unsupported.rollback.reason, "reverse_import_required");
  assert.equal(unsupported.rollback.sourceRetained, true);
  assert.equal(unsupported.rollback.destinationRetained, true);

  const stale = coordinator.rollback(state, {
    ...evidence, destinationWritersStopped: true, reverseImportVerified: true,
    reverseImport: {format: REVERSE_IMPORT_FORMAT, operationId: evidence.operationId,
      sourceGeneration: "source-0", destinationGeneration: "disk-generation-1", sha256: "a".repeat(64)},
  });
  assert.equal(stale.state, "blocked");
  assert.equal(stale.rollback.reason, "reverse_import_required");
});

test("rollback rehearsal preserves dirty workspace, agent history, and owner tool changes", async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-vm-rollback-"));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const source = path.join(parent, "source");
  const destination = path.join(parent, "destination");
  const restored = path.join(parent, "restored-source");
  const files = [
    ["workspace/dirty.txt", "edited on the VM\n", 0o640],
    ["agent/history/session.jsonl", '{"event":"new-turn"}\n', 0o600],
    ["home/.local/bin/workspace-tool", "#!/bin/sh\nprintf tool-ok\\n\n", 0o750],
  ];
  for (const [relative, content, mode] of files) {
    const target = path.join(source, relative);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.writeFile(target, content, {mode});
    await fs.chmod(target, mode);
  }
  await fs.cp(source, destination, {recursive: true, preserveTimestamps: true});
  await fs.mkdir(restored, {recursive: true});
  await fs.cp(destination, restored, {recursive: true, preserveTimestamps: true});

  const manifest = files.map(([relative, content, mode]) => ({relative, mode,
    sha256: createHash("sha256").update(content).digest("hex")}));
  const reverseImportSha = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  for (const [relative, content, mode] of files) {
    const target = path.join(restored, relative);
    assert.equal(await fs.readFile(target, "utf8"), content);
    assert.equal((await fs.stat(target)).mode & 0o777, mode);
  }

  const coordinator = createWorkspaceMigrationCoordinator();
  let state = coordinator.begin({...evidence, ownerUid: "owner-1", sourceGeneration: "source-1", destinationId: "disk-1"});
  state = coordinator.advance(state, "reserved", evidence);
  state = coordinator.advance(state, "quiescing", evidence);
  state = coordinator.advance(state, "captured", evidence);
  state = coordinator.advance(state, "imported", {...evidence, verified: true, destinationGeneration: "disk-generation-1"});
  const rolledBack = coordinator.rollback(state, {
    ...evidence, destinationWritersStopped: true, reverseImportVerified: true,
    reverseImport: {format: REVERSE_IMPORT_FORMAT, operationId: evidence.operationId,
      sourceGeneration: "source-1", destinationGeneration: "disk-generation-1", sha256: reverseImportSha},
  });
  assert.equal(rolledBack.state, "released");
  assert.equal(rolledBack.authority, "source");
  assert.equal(rolledBack.rollback.sourceRetained, true);
  assert.equal(rolledBack.rollback.destinationRetained, true);
  assert.equal((await fs.stat(source)).isDirectory(), true);
  assert.equal((await fs.stat(destination)).isDirectory(), true);
});
